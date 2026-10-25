import { verify } from "@octokit/webhooks-methods";
import { decideForComment, decideForPullRequest, type Decision, type ReviewJob } from "@ownrabbit/core";
import {
  collections,
  db,
  FieldValue,
  getRepoSettings,
  installationOctokit,
  mentionHandle,
} from "@ownrabbit/core/server";
import { env } from "@/lib/env";
import { enqueueReview } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

type Json = Record<string, any>;

function ok(body: Record<string, unknown> = {}) {
  return Response.json({ ok: true, ...body });
}

export async function POST(request: Request) {
  const event = request.headers.get("x-github-event") ?? "";
  const delivery = request.headers.get("x-github-delivery") ?? "";
  const signature = request.headers.get("x-hub-signature-256") ?? "";

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });

  const raw = await request.text();
  if (!signature || !(await verify(env.webhookSecret(), raw, signature).catch(() => false))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  switch (event) {
    case "ping":
      return ok({ pong: true });
    case "installation":
    case "installation_repositories":
      await syncInstallation(event, payload);
      return ok();
    case "pull_request":
      return handlePullRequest(delivery, payload);
    case "issue_comment":
      return handleComment(delivery, payload);
    default:
      return ok({ ignored: event });
  }
}

// ------------------------------------------------------------- installs

async function syncInstallation(event: string, payload: Json) {
  const installation = payload.installation;
  if (!installation?.id) return;
  const batch = db().batch();
  const repoCol = db().collection(collections.repos);

  const upsert = (repo: Json) =>
    batch.set(
      repoCol.doc(String(repo.id)),
      {
        repoId: repo.id,
        installationId: installation.id,
        fullName: repo.full_name,
        owner: String(repo.full_name).split("/")[0],
        name: repo.name,
        private: Boolean(repo.private),
        active: true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  const deactivate = (repo: Json) =>
    batch.set(repoCol.doc(String(repo.id)), { active: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  if (event === "installation") {
    const repos: Json[] = payload.repositories ?? [];
    if (payload.action === "created") repos.forEach(upsert);
    if (payload.action === "deleted" || payload.action === "suspend") repos.forEach(deactivate);
    if (payload.action === "unsuspend") repos.forEach(upsert);
    batch.set(
      db().collection(collections.installations).doc(String(installation.id)),
      {
        installationId: installation.id,
        account: installation.account?.login ?? null,
        accountType: installation.account?.type ?? null,
        active: payload.action !== "deleted" && payload.action !== "suspend",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } else {
    (payload.repositories_added ?? []).forEach(upsert);
    (payload.repositories_removed ?? []).forEach(deactivate);
  }
  await batch.commit();
}

// ------------------------------------------------------------- reviews

async function enqueue(
  delivery: string,
  decision: Extract<Decision, { review: true }>,
  payload: Json,
  prNumber: number,
  headSha: string,
  trigger: ReviewJob["trigger"],
  extra: Partial<ReviewJob> = {},
) {
  const job: ReviewJob = {
    jobId: delivery.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100),
    installationId: payload.installation.id,
    repoId: payload.repository.id,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    prNumber,
    headSha,
    mode: decision.mode,
    trigger,
    instructions: decision.instructions,
    ...extra,
  };
  const result = await enqueueReview(job);
  if (result === "queued") {
    await db()
      .collection(collections.reviews)
      .doc(job.jobId)
      .set(
        {
          jobId: job.jobId,
          repoId: job.repoId,
          fullName: payload.repository.full_name,
          prNumber,
          headSha,
          mode: job.mode,
          trigger,
          requestedBy: job.requestedBy,
          status: "queued",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }
  return ok({ result, mode: decision.mode });
}

async function handlePullRequest(delivery: string, payload: Json) {
  const pr = payload.pull_request;
  if (!pr || !payload.installation?.id || !payload.repository?.id) return ok({ ignored: "incomplete" });

  const { doc, settings } = await getRepoSettings(payload.repository.id);
  if (doc && doc.active === false) return ok({ ignored: "inactive" });

  const decision = decideForPullRequest(payload.action, pr, settings);
  if (!decision.review) return ok({ skipped: decision.reason });
  return enqueue(delivery, decision, payload, pr.number, pr.head.sha, "auto");
}

async function handleComment(delivery: string, payload: Json) {
  if (payload.action !== "created") return ok({ ignored: "action" });
  const comment = payload.comment;
  const issue = payload.issue;
  if (!comment || !issue || !payload.installation?.id || !payload.repository?.id) return ok({ ignored: "incomplete" });

  const { doc, settings } = await getRepoSettings(payload.repository.id);
  if (doc && doc.active === false) return ok({ ignored: "inactive" });

  const decision = decideForComment({
    body: comment.body ?? "",
    commenterType: comment.user?.type ?? "",
    authorAssociation: comment.author_association ?? "",
    isPullRequest: Boolean(issue.pull_request),
    mention: mentionHandle(),
    settings,
  });
  if (!decision.review) return ok({ skipped: decision.reason });

  // issue_comment payloads don't include the PR head; fetch it.
  const octokit = await installationOctokit(payload.installation.id);
  const { data: pr } = await octokit.rest.pulls.get({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pull_number: issue.number,
  });
  if (pr.state !== "open") return ok({ skipped: "pr-not-open" });

  return enqueue(delivery, decision, payload, pr.number, pr.head.sha, "mention", {
    commentId: comment.id,
    requestedBy: comment.user?.login,
  });
}
