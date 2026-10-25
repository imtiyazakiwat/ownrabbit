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
} from "@ownrabbit/core";
import { z } from "zod";
import { parsePatch, renderNumberedPatch, type ParsedPatch } from "./diff";
import { anchorFindings, dedupeFindings, selectFindings, type Finding } from "./findings";
import type { LlmClient } from "./llm";
import { mapLimit } from "./limit";
import { JUDGE_PROMPT, SUMMARY_PROMPT, TRIAGE_PROMPT, untrusted } from "./prompts";
import {
  renderReviewBody,
  renderSummaryComment,
  toReviewComments,
  type ReviewStats,
} from "./publish";
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
export interface GitHubPort {
  getPullRequest(): Promise<PullRequest>;
  listPullRequestFiles(): Promise<ChangedFile[]>;
  /** Files changed between two commits, or undefined if not comparable (e.g. force push). */
  compareFiles(base: string, head: string): Promise<string[] | undefined>;
  upsertSummaryComment(body: string, knownId?: number): Promise<number>;
  createReview(args: { commitId: string; body: string; comments: ReturnType<typeof toReviewComments> }): Promise<void>;
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
  | { status: "completed"; filesReviewed: number; findingsRaw: number; commentsPosted: number; failedPasses: number };

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
  const workspace = profile.toolSteps > 0 ? deps.createWorkspace(pr.headSha) : undefined;

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
        workspace,
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

  let raw: Finding[];
  let failedPasses: number;
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
  } finally {
    await workspace?.dispose();
  }
  if (failedPasses === units.length) throw new Error("All reviewers failed");

  // ---- judge + select
  let findings = dedupeFindings(raw);
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
  const selected = selectFindings(findings, settings.minSeverity, settings.maxComments);
  // Nits don't deserve an inline notification each; they go in a collapsible list in the review body.
  const posted = selected.filter((f) => f.severity !== "nit");
  const nits = selected.filter((f) => f.severity === "nit");
  run.stage("publish", `Publishing ${posted.length} comments`, { failedPasses });

  // ---- publish summary (always on full reviews, or if none exists yet)
  let summaryCommentId = await state.getSummaryCommentId();
  if (mode === "full" || summaryCommentId === undefined) {
    try {
      const markdown = await runSummary(llm, settings, pr, reviewFiles, ctx.prSummary, signal);
      summaryCommentId = await github.upsertSummaryComment(
        renderSummaryComment(markdown, pr.headSha),
        summaryCommentId,
      );
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
  try {
    await github.createReview({
      commitId: pr.headSha,
      body: renderReviewBody(stats, deps.mention),
      comments: toReviewComments(posted),
    });
  } catch (err) {
    // 422 means GitHub rejected an inline position. Fall back to listing
    // every finding in the review body so nothing is lost.
    if ((err as { status?: number }).status !== 422) throw err;
    log("inline comments rejected, posting findings in review body");
    run.log("warn", "GitHub rejected inline comments, posted findings in the review body");
    await github.createReview({
      commitId: pr.headSha,
      body: renderReviewBody({ ...stats, unplaced: posted }, deps.mention),
      comments: [],
    });
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
