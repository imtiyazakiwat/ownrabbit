/**
 * Review pipeline:
 *   load PR -> pick files (full / incremental) -> triage -> N specialist
 *   reviewers in parallel over file batches -> anchor + dedupe -> judge ->
 *   select -> publish summary + review -> persist state.
 */
import {
  createPathFilter,
  DEPTH_PROFILES,
  type RepoSettings,
  type ReviewJob,
  type ReviewerKind,
  severityRank,
} from "@ownrabbit/core";
import { z } from "zod";
import { parsePatch, renderNumberedPatch, type ParsedPatch } from "./diff";
import { anchorFindings, dedupeFindings, selectFindings, type Finding } from "./findings";
import type { LlmClient } from "./llm";
import { mapLimit } from "./limit";
import { JUDGE_PROMPT, SUMMARY_PROMPT, TRIAGE_PROMPT, untrusted } from "./prompts";
import {
  renderPrincipalReviewBody,
  renderReviewBody,
  renderSummaryComment,
  toReviewComments,
  type PrincipalView,
  type ReviewStats,
} from "./publish";

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";
import { loadGuidelines, type GuidelineSource, type Guidelines } from "./guidelines";
import { deriveVerdict, runPrincipal, type PrincipalReport, type Verdict } from "./principal";
import { runReviewer, type ReviewContext, type ReviewFile } from "./reviewer";
import type { Workspace } from "./repo";
import type { RunLog } from "./runlog";

// ------------------------------------------------------------------ ports

export interface PullRequest {
  number: number;
  state: string;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
}

export interface ChangedFile {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
}

/** GitHub operations the pipeline needs. Implemented with Octokit in github.ts. */
export interface GitHubPort extends GuidelineSource {
  getPullRequest(): Promise<PullRequest>;
  listPullRequestFiles(): Promise<ChangedFile[]>;
  /** Files changed between two commits, or undefined if not comparable (e.g. force push). */
  compareFiles(base: string, head: string): Promise<string[] | undefined>;
  upsertSummaryComment(body: string, knownId?: number): Promise<number>;
  createReview(args: {
    commitId: string;
    body: string;
    comments: ReturnType<typeof toReviewComments>;
    event?: ReviewEvent;
  }): Promise<void>;
  /** Dismiss our earlier REQUEST_CHANGES reviews; a COMMENT review does not clear them. */
  dismissStaleChangeRequests(message: string): Promise<number>;
}

export interface StatePort {
  getLastReviewedSha(): Promise<string | undefined>;
  getSummaryCommentId(): Promise<number | undefined>;
  /** Merge-update; omitted fields are left unchanged. */
  saveState(state: { lastReviewedSha?: string; summaryCommentId?: number }): Promise<void>;
}

export interface PipelineDeps {
  job: ReviewJob;
  settings: RepoSettings;
  github: GitHubPort;
  state: StatePort;
  llm: LlmClient;
  createWorkspace: (sha: string) => Workspace;
  mention: string;
  signal?: AbortSignal;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /**
   * Time budget for the reviewer phase. When it runs out, unfinished passes
   * count as failed and the pipeline still publishes a partial review,
   * instead of the whole job hitting the hard deadline with nothing posted.
   */
  reviewBudgetMs?: number;
  /** Structured per-run events for the dashboard monitor. */
  run?: Pick<RunLog, "stage" | "log">;
}

export type PipelineResult =
  | { status: "skipped"; reason: string }
  | {
      status: "completed";
      filesReviewed: number;
      findingsRaw: number;
      commentsPosted: number;
      failedPasses: number;
      /** Present when the principal pass ran. */
      verdict?: Verdict;
    };

// ------------------------------------------------------------------ limits

const MAX_FILES = 150;
const BATCH_CHAR_BUDGET = 60_000;
const MAX_PATCH_CHARS = 40_000;
const REVIEWER_CONCURRENCY = 4;
const RETRY_CONCURRENCY = 2;
const JUDGE_MIN_SCORE = 6;

// ------------------------------------------------------------------ pipeline

export async function runReviewPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { job, settings, github, state, llm, log, signal } = deps;
  const run = deps.run ?? { stage: () => undefined, log: () => undefined };
  const profile = DEPTH_PROFILES[settings.depth];

  run.stage("load", `Loading PR #${job.prNumber}`, { depth: settings.depth, reviewers: settings.reviewers.join(", ") });
  const pr = await github.getPullRequest();
  if (pr.state !== "open") return { status: "skipped", reason: "pr-not-open" };
  // Auto reviews for an older push are superseded by the newer push's job.
  if (job.trigger === "auto" && pr.headSha !== job.headSha) return { status: "skipped", reason: "superseded" };

  const lastReviewedSha = await state.getLastReviewedSha();
  if (job.trigger === "auto" && job.mode === "incremental" && lastReviewedSha === pr.headSha) {
    return { status: "skipped", reason: "already-reviewed" };
  }

  // ---- choose files
  const allFiles = await github.listPullRequestFiles();
  let mode = job.mode;
  let scope: Set<string> | undefined;
  if (mode === "incremental") {
    if (lastReviewedSha && lastReviewedSha !== pr.headSha) {
      const changed = await github.compareFiles(lastReviewedSha, pr.headSha).catch(() => undefined);
      if (changed) scope = new Set(changed);
      else mode = "full";
    } else {
      // Nothing reviewed yet, or nothing new: review the whole PR.
      mode = "full";
    }
  }

  const keepPath = createPathFilter(settings);
  const patches = new Map<string, ParsedPatch>();
  const candidates: ChangedFile[] = [];
  let skipped = 0;
  for (const file of allFiles) {
    const inScope = !scope || scope.has(file.filename);
    const reviewable =
      file.status !== "removed" && !!file.patch && file.patch.length <= MAX_PATCH_CHARS && keepPath(file.filename);
    if (!inScope) continue;
    if (!reviewable) {
      skipped++;
      continue;
    }
    patches.set(file.filename, parsePatch(file.patch));
    candidates.push(file);
  }

  run.log("info", `${candidates.length} reviewable files, ${skipped} skipped`, { mode, total: allFiles.length });
  if (candidates.length === 0) {
    await state.saveState({ lastReviewedSha: pr.headSha });
    return { status: "skipped", reason: scope ? "no-reviewable-changes-since-last-review" : "no-reviewable-files" };
  }

  // ---- triage
  run.stage("triage", `Triaging with ${settings.triageModel}`);
  const triage = await runTriage(llm, settings, pr, candidates, signal).catch((err: Error) => {
    log("triage failed, continuing without it", { error: err.message });
    run.log("warn", "Triage failed, continuing without it", { error: err.message });
    return undefined;
  });
  const meta = new Map(triage?.files.map((f) => [f.path, f]) ?? []);
  const riskOrder = { high: 0, medium: 1, low: 2, skip: 3 } as const;

  const reviewFiles: ReviewFile[] = candidates
    .map((file) => ({
      path: file.filename,
      status: file.status,
      risk: meta.get(file.filename)?.risk ?? "medium",
      summary: meta.get(file.filename)?.summary,
      numbered: renderNumberedPatch(patches.get(file.filename)!),
    }))
    .filter((f) => f.risk !== "skip")
    .sort((a, b) => riskOrder[a.risk as keyof typeof riskOrder] - riskOrder[b.risk as keyof typeof riskOrder])
    .slice(0, MAX_FILES);
  skipped += candidates.length - reviewFiles.length;

  // ---- specialists
  const ctx: ReviewContext = {
    title: pr.title,
    description: pr.body,
    prSummary: triage?.summary ?? "",
    instructions: job.instructions,
  };
  const batches = batchFiles(reviewFiles, BATCH_CHAR_BUDGET);
  const usePrincipal = settings.principalReview && profile.principalSteps > 0;
  const workspace = profile.toolSteps > 0 || usePrincipal ? deps.createWorkspace(pr.headSha) : undefined;

  // Maintainer-written rules from the base commit; the PR under review cannot change them.
  let guidelines: Guidelines | undefined;
  if (settings.useRepoGuidelines) {
    guidelines = await loadGuidelines(github, pr.baseSha).catch((err: Error) => {
      run.log("warn", "Could not load repository guidelines", { error: err.message });
      return undefined;
    });
    if (guidelines) run.log("info", `Loaded ${guidelines.files.length} guideline files`, { files: guidelines.files.join(", ") });
  }

  let nextId = 0;
  const allocate = () => ++nextId;
  const units = settings.reviewers.flatMap((kind) => batches.map((files, batch) => ({ kind, files, batch })));
  run.stage("review", `Running ${units.length} reviewer passes`, {
    files: reviewFiles.length,
    batches: batches.length,
    toolSteps: profile.toolSteps,
  });

  /** One reviewer over one batch. Resolves to undefined on failure so siblings keep going. */
  const reviewSignal = deps.reviewBudgetMs
    ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(deps.reviewBudgetMs)])
    : signal;

  const runUnit = async (
    { kind, files, batch }: (typeof units)[number],
    model = settings.model,
  ): Promise<Finding[] | undefined> => {
    if (reviewSignal?.aborted) return undefined;
    const label = batches.length > 1 ? `${kind} #${batch + 1}` : kind;
    const startedAt = Date.now();
    try {
      const found = await runReviewer({
        kind,
        llm,
        settings: model === settings.model ? settings : { ...settings, model },
        toolSteps: profile.toolSteps,
        ctx,
        files,
        workspace: profile.toolSteps > 0 ? workspace : undefined,
        guidelines: guidelines?.text,
        signal: reviewSignal,
        log: (m) => {
          log(m);
          run.log("info", m, { reviewer: label });
        },
      });
      const anchored = anchorFindings(kind as ReviewerKind, found, patches, allocate);
      run.log("info", `${label}: ${anchored.length} findings (${found.length - anchored.length} dropped by anchoring)`, {
        reviewer: label,
        ms: Date.now() - startedAt,
      });
      return anchored;
    } catch (err) {
      // The job itself was cancelled: stop everything. A spent review budget is just a failed pass.
      if (signal?.aborted) throw err;
      const message = reviewSignal?.aborted ? "review time budget exhausted" : (err as Error).message;
      log("reviewer failed", { reviewer: kind, error: message });
      run.log("error", `${label} failed`, { reviewer: label, error: message });
      return undefined;
    }
  };

  let raw: Finding[] = [];
  let failedPasses = 0;
  let findings: Finding[] = [];
  let principal: PrincipalReport | undefined;
  let summaryMarkdown: Promise<string | undefined> = Promise.resolve(undefined);
  let summaryCommentId = await state.getSummaryCommentId();
  try {
    const outcomes = await mapLimit(units, REVIEWER_CONCURRENCY, (unit) => runUnit(unit));
    // Upstream model errors are often transient. Give failed passes one more
    // chance at low concurrency before declaring them lost.
    const failedIdx = outcomes.flatMap((o, i) => (o === undefined ? [i] : []));
    if (failedIdx.length > 0 && !reviewSignal?.aborted) {
      // Upstream outages tend to be per-model, so the retry goes to the fallback model when one is configured.
      const fallback = settings.triageModel || settings.model;
      log("retrying failed reviewer passes", { count: failedIdx.length, model: fallback });
      run.log("warn", `Retrying ${failedIdx.length} failed reviewer passes on ${fallback}`);
      const retried = await mapLimit(failedIdx, RETRY_CONCURRENCY, (i) => runUnit(units[i]!, fallback));
      failedIdx.forEach((unitIndex, j) => {
        outcomes[unitIndex] = retried[j];
      });
    }
    raw = outcomes.flatMap((o) => o ?? []);
    failedPasses = outcomes.filter((o) => o === undefined).length;
    if (failedPasses === units.length) throw new Error("All reviewers failed");

    // ---- judge
    findings = dedupeFindings(raw);
    if (profile.useJudge && findings.length > 0) {
      run.stage("judge", `Judging ${findings.length} candidate findings`, { raw: raw.length });
      const before = findings.length;
      findings = await runJudge(llm, settings, ctx, findings, signal).catch((err: Error) => {
        log("judge failed, keeping deduped findings", { error: err.message });
        run.log("warn", "Judge failed, keeping deduped findings", { error: err.message });
        return findings;
      });
      run.log("info", `Judge kept ${findings.length} of ${before}`);
    }

    // The summary doesn't depend on findings, so it runs alongside the principal pass.
    if (mode === "full" || summaryCommentId === undefined) {
      summaryMarkdown = runSummary(llm, settings, pr, reviewFiles, ctx.prSummary, signal).catch((err: Error) => {
        log("summary failed", { error: err.message });
        run.log("warn", "Summary failed", { error: err.message });
        return undefined;
      });
    }

    // ---- principal
    if (usePrincipal) {
      run.stage("principal", `Principal pass over ${findings.length} findings`, { toolSteps: profile.principalSteps });
      const startedAt = Date.now();
      const failedUnits = units.flatMap((u, i) =>
        outcomes[i] === undefined ? [{ kind: u.kind, files: u.files.map((f) => f.path) }] : [],
      );
      const diffStats = new Map(candidates.map((c) => [c.filename, c]));
      const principalArgs = {
        llm,
        settings,
        ctx,
        files: reviewFiles.map((f) => ({
          ...f,
          additions: diffStats.get(f.path)?.additions,
          deletions: diffStats.get(f.path)?.deletions,
        })),
        findings,
        failedPasses: failedUnits,
        patches,
        allocate,
        toolSteps: profile.principalSteps,
        workspace,
        guidelines: guidelines?.text,
        signal,
        log: (m: string) => {
          log(m);
          run.log("info", m, { reviewer: "principal" });
        },
      };
      principal = await runPrincipal({ ...principalArgs, model: settings.model }).catch(async (err: Error) => {
        if (signal?.aborted) throw err;
        const fallback = settings.triageModel || settings.model;
        run.log("warn", `Principal pass failed, retrying on ${fallback}`, { error: err.message });
        return runPrincipal({ ...principalArgs, model: fallback }).catch((retryErr: Error) => {
          if (signal?.aborted) throw retryErr;
          log("principal failed", { error: retryErr.message });
          run.log("error", "Principal pass failed, publishing the specialist review", { error: retryErr.message });
          return undefined;
        });
      });
      if (principal) {
        run.log(
          "info",
          `Principal kept ${principal.kept.length}, dismissed ${principal.dismissed.length}, added ${principal.added.length + principal.outside.length}`,
          { ms: Date.now() - startedAt, lookups: principal.toolCalls.length },
        );
        findings = [...principal.kept, ...principal.added];
      }
    }
  } finally {
    await workspace?.dispose();
  }

  // ---- select
  const selected = selectFindings(findings, settings.minSeverity, settings.maxComments);
  // Nits don't deserve an inline notification each; they go in a collapsible list in the review body.
  const posted = selected.filter((f) => f.severity !== "nit");
  const nits = selected.filter((f) => f.severity === "nit");

  // The verdict counts every surviving finding, not just the ones that fit the inline cap or the
  // minSeverity filter: hiding a major from the inline view must not turn it into an approval.
  const verdictFindings = principal
    ? [...findings, ...principal.outside].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    : findings;
  const verdict = principal ? deriveVerdict(verdictFindings, principal.questions.length) : undefined;
  // REQUEST_CHANGES only from a complete review: a partial one can't vouch that it saw everything.
  const event: ReviewEvent =
    settings.requestChanges && failedPasses === 0 && (verdict === "REQUEST_CHANGES" || verdict === "BLOCK")
      ? "REQUEST_CHANGES"
      : "COMMENT";
  run.stage("publish", `Publishing ${posted.length} comments${verdict ? `, verdict ${verdict}` : ""}`, { failedPasses, event });

  // ---- publish summary (always on full reviews, or if none exists yet)
  const markdown = await summaryMarkdown;
  if (markdown) {
    try {
      summaryCommentId = await github.upsertSummaryComment(renderSummaryComment(markdown, pr.headSha), summaryCommentId);
    } catch (err) {
      log("summary failed", { error: (err as Error).message });
      run.log("warn", "Summary failed", { error: (err as Error).message });
    }
  }

  // ---- publish review
  const stats: ReviewStats = {
    mode,
    headSha: pr.headSha,
    baseSha: mode === "incremental" ? lastReviewedSha : undefined,
    filesReviewed: reviewFiles.length,
    filesSkipped: skipped,
    reviewers: settings.reviewers,
    depth: settings.depth,
    raw: raw.length,
    posted,
    unplaced: [],
    nits,
    failedPasses,
    totalPasses: units.length,
  };
  const body = (inline: Finding[]) => {
    if (!principal || !verdict) return renderReviewBody({ ...stats, unplaced: posted.filter((f) => !inline.includes(f)) }, deps.mention);
    const view: PrincipalView = {
      report: principal,
      verdict,
      findings: verdictFindings,
      inlineIds: new Set(inline.map((f) => f.id)),
      files: {
        additions: candidates.reduce((n, f) => n + f.additions, 0),
        deletions: candidates.reduce((n, f) => n + f.deletions, 0),
      },
      baseSha: pr.baseSha,
      guidelineFiles: guidelines?.files ?? [],
    };
    return renderPrincipalReviewBody(stats, view, deps.mention);
  };

  const publish = async (inline: Finding[], reviewEvent: ReviewEvent) =>
    github.createReview({ commitId: pr.headSha, body: body(inline), comments: toReviewComments(inline), event: reviewEvent });

  try {
    await publish(posted, event);
  } catch (err) {
    // 422 means GitHub rejected an inline position, or (on our own PRs) a
    // REQUEST_CHANGES event. Retry as a plain comment with every finding in
    // the body so nothing is lost.
    if ((err as { status?: number }).status !== 422) throw err;
    log("review rejected (422), posting findings in review body", { event });
    run.log("warn", "GitHub rejected the review (422), posted it as a comment with findings in the body", { event });
    await publish([], "COMMENT");
  }

  // A COMMENT review does not clear our earlier REQUEST_CHANGES, so clear it
  // ourselves once a complete review no longer requests changes.
  if (settings.requestChanges && event === "COMMENT" && verdict && failedPasses === 0) {
    const dismissed = await github
      .dismissStaleChangeRequests(`Superseded by OwnRabbit review of ${pr.headSha.slice(0, 7)} (${verdict.replace(/_/g, " ")}).`)
      .catch((err: Error) => {
        run.log("warn", "Could not dismiss earlier change requests", { error: err.message });
        return 0;
      });
    if (dismissed > 0) run.log("info", `Dismissed ${dismissed} earlier change request(s)`);
  }

  // A partial review must not advance the incremental cursor, or the files
  // the failed reviewers never saw would be skipped on the next push.
  if (failedPasses === 0) {
    await state.saveState({ lastReviewedSha: pr.headSha, summaryCommentId });
  } else if (summaryCommentId !== undefined) {
    await state.saveState({ summaryCommentId });
  }
  return {
    status: "completed",
    filesReviewed: reviewFiles.length,
    findingsRaw: raw.length,
    commentsPosted: posted.length + nits.length,
    failedPasses,
    ...(verdict ? { verdict } : {}),
  };
}

// ------------------------------------------------------------------ stages

export function batchFiles(files: ReviewFile[], budget: number): ReviewFile[][] {
  const batches: ReviewFile[][] = [];
  let current: ReviewFile[] = [];
  let size = 0;
  for (const file of files) {
    const cost = file.numbered.length + file.path.length + 100;
    if (current.length > 0 && size + cost > budget) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const TriageSchema = z.object({
  summary: z.string().catch(""),
  files: z
    .array(
      z.object({
        path: z.string(),
        summary: z.string().catch(""),
        risk: z.enum(["high", "medium", "low", "skip"]).catch("medium"),
      }),
    )
    .catch([]),
});

async function runTriage(
  llm: LlmClient,
  settings: RepoSettings,
  pr: PullRequest,
  files: ChangedFile[],
  signal?: AbortSignal,
) {
  // Triage sees a head of each patch so it can judge risk without the full diff.
  const listing = files
    .map((f) => `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${(f.patch ?? "").slice(0, 1500)}`)
    .join("\n\n");
  return llm.chatJson(
    {
      model: settings.triageModel,
      signal,
      messages: [
        { role: "system", content: TRIAGE_PROMPT },
        {
          role: "user",
          content: [
            untrusted("pr-title", pr.title),
            untrusted("pr-description", pr.body || "(no description)"),
            untrusted("changed-files", listing.slice(0, 120_000)),
          ].join("\n\n"),
        },
      ],
    },
    TriageSchema,
  );
}

const JudgeSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.coerce.number(),
      keep: z.boolean().optional(),
      score: z.coerce.number().min(0).max(10).optional().catch(undefined),
      severity: z.enum(["critical", "major", "minor", "nit"]).optional().catch(undefined),
    }),
  ),
});

async function runJudge(
  llm: LlmClient,
  settings: RepoSettings,
  ctx: ReviewContext,
  findings: Finding[],
  signal?: AbortSignal,
): Promise<Finding[]> {
  const candidates = findings.map((f) => ({
    id: f.id,
    reviewer: f.reviewer,
    path: f.path,
    line: f.startLine ? `${f.startLine}-${f.line}` : f.line,
    severity: f.severity,
    title: f.title,
    scenario: f.scenario,
    quoteVerified: f.verified,
    body: f.body,
    suggestion: f.suggestion,
    confidence: f.confidence,
  }));
  const result = await llm.chatJson(
    {
      model: settings.model,
      signal,
      messages: [
        { role: "system", content: JUDGE_PROMPT },
        {
          role: "user",
          content: [
            `# PR summary\n${ctx.prSummary || "(none)"}`,
            untrusted("pr-title", ctx.title),
            `# Candidate findings`,
            untrusted("findings", JSON.stringify(candidates, null, 1)),
          ].join("\n\n"),
        },
      ],
    },
    JudgeSchema,
  );

  const verdicts = new Map(result.verdicts.map((v) => [v.id, v]));
  return findings.flatMap((f) => {
    const verdict = verdicts.get(f.id);
    // A finding the judge forgot to rule on is kept; the judge filters noise, it does not gate.
    if (!verdict) return [f];
    // The score is the calibrated signal; "keep" is a fallback for models that omit it.
    const keep = verdict.score !== undefined ? verdict.score >= JUDGE_MIN_SCORE : verdict.keep !== false;
    if (!keep) return [];
    return [{ ...f, severity: verdict.severity ?? f.severity }];
  });
}

const SummarySchema = z.object({ markdown: z.string().min(1) });

async function runSummary(
  llm: LlmClient,
  settings: RepoSettings,
  pr: PullRequest,
  files: ReviewFile[],
  triageSummary: string,
  signal?: AbortSignal,
): Promise<string> {
  const listing = files.map((f) => `- ${f.path} (${f.status})${f.summary ? `: ${f.summary}` : ""}`).join("\n");
  const diffs = files.map((f) => `### ${f.path}\n${f.numbered}`).join("\n\n").slice(0, 80_000);
  const result = await llm.chatJson(
    {
      model: settings.model,
      signal,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        {
          role: "user",
          content: [
            `# Triage summary\n${triageSummary || "(none)"}`,
            untrusted("pr-title", pr.title),
            untrusted("pr-description", pr.body || "(no description)"),
            `# Files\n${listing}`,
            untrusted("diffs", diffs),
          ].join("\n\n"),
        },
      ],
    },
    SummarySchema,
  );
  return result.markdown;
}
