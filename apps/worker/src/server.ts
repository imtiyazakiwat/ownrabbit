/**
 * Cloud Run entry point. Cloud Tasks POSTs a ReviewJob to /review with a
 * Google-signed OIDC token for our service account; anything else is rejected.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OAuth2Client } from "google-auth-library";
import { ReviewJobSchema, type ReviewJob } from "@ownrabbit/core";
import {
  botLogin,
  collections,
  db,
  FieldValue,
  getRepoSettings,
  installationOctokit,
  mentionHandle,
  prStateId,
  type PrStateDoc,
} from "@ownrabbit/core/server";
import { createGitHubPort } from "./github";
import { createLlmClient } from "./llm";
import { runReviewPipeline, type StatePort } from "./orchestrator";
import { renderFailureComment } from "./publish";
import { createLazyWorkspace } from "./repo";
import { createRunLog, type RunSink } from "./runlog";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_BODY = 64 * 1024;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 25 * 60_000);
/** A "running" lease older than this is considered abandoned (crashed instance). */
const LEASE_MS = JOB_TIMEOUT_MS + 60_000;

const config = {
  audience: process.env.TASKS_AUDIENCE ?? "",
  invokerEmail: process.env.TASKS_INVOKER_EMAIL ?? "",
  llmBaseUrl: process.env.LLM_BASE_URL ?? "",
  llmApiKey: process.env.LLM_API_KEY ?? "",
};
const authClient = new OAuth2Client();

function log(message: string, extra: Record<string, unknown> = {}) {
  // Structured logs are parsed by Cloud Logging.
  console.log(JSON.stringify({ severity: "INFO", message, ...extra }));
}
function logError(message: string, extra: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ severity: "ERROR", message, ...extra }));
}

async function verifyCaller(req: IncomingMessage): Promise<boolean> {
  if (process.env.WORKER_AUTH_DISABLED === "1" && process.env.NODE_ENV !== "production") return true;
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !config.audience || !config.invokerEmail) return false;
  try {
    const ticket = await authClient.verifyIdToken({ idToken: token, audience: config.audience });
    const payload = ticket.getPayload();
    return payload?.email === config.invokerEmail && payload.email_verified === true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Claim the job atomically. Cloud Tasks may deliver more than once, so a job
 * that is completed, or currently leased by another instance, is not re-run.
 */
async function claimJob(job: ReviewJob): Promise<boolean> {
  const ref = db().collection(collections.reviews).doc(job.jobId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (data) {
      if (data.status === "completed" || data.status === "skipped") return false;
      const leasedAt = data.leasedAt?.toMillis?.() ?? 0;
      if (data.status === "running" && Date.now() - leasedAt < LEASE_MS) return false;
    }
    tx.set(
      ref,
      {
        jobId: job.jobId,
        repoId: job.repoId,
        fullName: `${job.owner}/${job.repo}`,
        prNumber: job.prNumber,
        headSha: job.headSha,
        mode: job.mode,
        trigger: job.trigger,
        requestedBy: job.requestedBy,
        status: "running",
        leasedAt: FieldValue.serverTimestamp(),
        attempts: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
        ...(data ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
    return true;
  });
}

function createStatePort(job: ReviewJob): StatePort {
  const ref = db().collection(collections.prState).doc(prStateId(job.repoId, job.prNumber));
  let cached: PrStateDoc | undefined;
  const load = async () => (cached ??= ((await ref.get()).data() as PrStateDoc | undefined) ?? {});
  return {
    getLastReviewedSha: async () => (await load()).lastReviewedSha,
    getSummaryCommentId: async () => (await load()).summaryCommentId,
    saveState: async (state) => {
      await ref.set({ ...state, repoId: job.repoId, prNumber: job.prNumber, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },
  };
}

/** Events go to reviews/{jobId}/events; the parent doc carries the live stage for list views. */
function firestoreSink(jobId: string): RunSink {
  const reviewRef = db().collection(collections.reviews).doc(jobId);
  return {
    async write(events, stage) {
      const batch = db().batch();
      for (const event of events) {
        batch.set(reviewRef.collection("events").doc(String(event.seq).padStart(4, "0")), event);
      }
      const last = events.at(-1);
      batch.set(
        reviewRef,
        { stage, eventCount: last?.seq, lastMessage: last?.message, heartbeatAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      await batch.commit();
    },
  };
}

async function installationToken(octokit: Awaited<ReturnType<typeof installationOctokit>>): Promise<string> {
  const auth = (await octokit.auth({ type: "installation" })) as { token: string };
  return auth.token;
}

async function handleReview(job: ReviewJob): Promise<number> {
  if (!(await claimJob(job))) {
    log("job already handled or in progress", { jobId: job.jobId });
    return 200;
  }
  const reviewRef = db().collection(collections.reviews).doc(job.jobId);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Review timed out")), JOB_TIMEOUT_MS);
  const run = createRunLog(firestoreSink(job.jobId));
  run.stage("start", `Worker picked up ${job.trigger} ${job.mode} review`, { sha: job.headSha.slice(0, 7) });

  const { settings } = await getRepoSettings(job.repoId);
  const octokit = await installationOctokit(job.installationId);
  const github = createGitHubPort({
    octokit,
    owner: job.owner,
    repo: job.repo,
    prNumber: job.prNumber,
    botLogin: botLogin(),
  });

  try {
    if (job.commentId) {
      await octokit.rest.reactions
        .createForIssueComment({ owner: job.owner, repo: job.repo, comment_id: job.commentId, content: "eyes" })
        .catch(() => undefined);
    }

    const llm = createLlmClient({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      onRetry: ({ attempt, delayMs, error }) =>
        run.log("warn", `Model call failed, retry ${attempt} in ${Math.round(delayMs / 1000)}s`, { error }),
    });
    const result = await runReviewPipeline({
      job,
      settings,
      github,
      state: createStatePort(job),
      llm,
      mention: mentionHandle(),
      signal: controller.signal,
      // Leave the last 30% of the deadline for judge, summary, and publishing.
      reviewBudgetMs: Math.round(JOB_TIMEOUT_MS * 0.7),
      run,
      createWorkspace: (sha) =>
        createLazyWorkspace({
          owner: job.owner,
          repo: job.repo,
          sha,
          // Fetched at clone time so the short-lived token is fresh.
          getToken: () => installationToken(octokit),
        }),
      log: (message, extra) => log(message, { jobId: job.jobId, ...extra }),
    });

    run.stage(
      result.status === "skipped" ? "skipped" : "done",
      result.status === "skipped"
        ? `Skipped: ${result.reason}`
        : `Done: ${result.commentsPosted} comments on ${result.filesReviewed} files`,
      { tokensUsed: llm.tokensUsed, ms: Date.now() - started },
    );
    await run.close();
    await reviewRef.set(
      {
        status: result.status,
        ...(result.status === "skipped"
          ? { reason: result.reason }
          : {
              filesReviewed: result.filesReviewed,
              findingsRaw: result.findingsRaw,
              commentsPosted: result.commentsPosted,
              failedPasses: result.failedPasses,
            }),
        tokensUsed: llm.tokensUsed,
        durationMs: Date.now() - started,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    log("review finished", { jobId: job.jobId, ...result, durationMs: Date.now() - started });
    return 200;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logError("review failed", { jobId: job.jobId, error: message, stack: (err as Error).stack });
    run.stage("failed", "Review failed", { error: message.slice(0, 500) });
    await run.close();
    await reviewRef.set(
      { status: "failed", error: message.slice(0, 500), durationMs: Date.now() - started, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    // Only tell humans on explicit requests; auto-review failures stay in the dashboard.
    if (job.trigger === "mention") {
      await octokit.rest.issues
        .createComment({
          owner: job.owner,
          repo: job.repo,
          issue_number: job.prNumber,
          body: renderFailureComment("an internal error occurred", mentionHandle()),
        })
        .catch(() => undefined);
    }
    // Return 200 so Cloud Tasks does not retry a deterministic failure and double-post.
    return 200;
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer(async (req, res) => {
  try {
    // Not /healthz: Cloud Run's frontend reserves paths ending in "z".
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
    if (req.method !== "POST" || req.url !== "/review") return send(res, 404, { error: "not found" });
    if (!(await verifyCaller(req))) return send(res, 401, { error: "unauthorized" });

    const parsed = ReviewJobSchema.safeParse(JSON.parse(await readBody(req)));
    if (!parsed.success) return send(res, 400, { error: "invalid job" });
    const status = await handleReview(parsed.data);
    return send(res, status, { ok: status === 200 });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    logError("request failed", { error: (err as Error).message });
    if (!res.headersSent) send(res, status, { error: "internal error" });
  }
});

server.requestTimeout = JOB_TIMEOUT_MS + 120_000;
server.listen(PORT, () => log(`worker listening on ${PORT}`));

process.on("SIGTERM", () => {
  log("SIGTERM received, closing server");
  server.close(() => process.exit(0));
});
