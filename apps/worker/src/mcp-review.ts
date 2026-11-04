/**
 * Local MCP publisher for the opencode review agent.
 *
 * The agent is allowed to read the checkout and call these tools, but it never
 * receives a GitHub token and cannot edit code. Validation, anchoring, dedupe,
 * limits, and idempotency live here so a model mistake cannot bypass them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SEVERITIES, REVIEWER_KINDS, severityRank, type ReviewerKind } from "@ownrabbit/core";
import { Octokit } from "octokit";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { parsePatch, renderNumberedPatch, type ParsedPatch } from "./diff";
import { anchorFindings, dedupeFindings, selectFindings, RawFindingSchema, type Finding } from "./findings";
import { createGitHubPort } from "./github";
import { deriveVerdict, type PrincipalReport, type Verdict } from "./principal";
import {
  renderInlineComment,
  renderPrincipalReviewBody,
  renderReviewBody,
  renderSummaryComment,
  reviewMarker,
  toReviewComments,
  type ReviewStats,
} from "./publish";
import { OpenCodeJobSchema, OPENCODE_RESULT_FILE, type OpenCodeJob, type OpenCodeResult } from "./review-job";

const RESULT_PATH = process.env.OWNRABBIT_RESULT ?? `${process.cwd()}/${OPENCODE_RESULT_FILE}`;
const DIFF_BUDGET = 120_000;
const MAX_POST_ATTEMPTS = 3;
const MIN_CONFIDENCE = 0.55;

const FindingInput = z.object({
  path: z.string().min(1).max(400),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  severity: z.enum(SEVERITIES),
  category: z.string().max(60).optional(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(6000),
  suggestion: z.string().max(8000).optional(),
  existingCode: z.string().min(1).max(4000),
  scenario: z.string().max(1000).optional(),
  effort: z.enum(["trivial", "small", "medium", "large"]).optional(),
  agentPrompt: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  focus: z.enum(REVIEWER_KINDS).optional(),
});

const ReviewInput = {
  summary: z.string().trim().min(1).max(12_000),
  findings: z.array(FindingInput).max(50).default([]),
  reviewedFiles: z.array(z.string().min(1).max(400)).max(300),
  skippedFiles: z
    .array(z.object({ path: z.string().min(1).max(400), reason: z.string().min(1).max(500) }))
    .max(100)
    .default([]),
  verdict: z.enum(["APPROVE", "APPROVE_WITH_COMMENTS", "REQUEST_CHANGES", "BLOCK"]).optional(),
  verdictReason: z.string().max(3000).default(""),
  risks: z
    .array(
      z.object({
        area: z.string().min(1).max(60),
        rating: z.enum(["low", "med", "high", "n/a"]).default("n/a"),
        reason: z.string().max(400).default(""),
      }),
    )
    .max(10)
    .default([]),
  questions: z.array(z.string().max(1000)).max(20).default([]),
  futureBreak: z.array(z.string().max(1000)).max(10).default([]),
  doneWell: z.array(z.string().max(1000)).max(10).default([]),
  traced: z.array(z.string().max(1000)).max(20).default([]),
  notVerified: z.array(z.object({ item: z.string().max(300), how: z.string().max(1000) })).max(20).default([]),
  references: z.array(z.string().max(300)).max(20).default([]),
};

function writeResult(result: OpenCodeResult): void {
  try {
    writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("could not write MCP result", err);
  }
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function errorText(value: string) {
  return { content: [{ type: "text" as const, text: value }], isError: true as const };
}

function normalizePath(value: string): string {
  return value.trim().replace(/^\.?\/+/, "").replace(/^[ab]\//, "");
}

function focusFor(finding: { focus?: ReviewerKind; category?: string; title: string }): ReviewerKind {
  if (finding.focus) return finding.focus;
  const text = `${finding.category ?? ""} ${finding.title}`.toLowerCase();
  if (/security|auth|inject|xss|csrf|secret|crypto|permission/.test(text)) return "security";
  if (/performance|slow|n\+1|memory|leak|blocking|cache/.test(text)) return "performance";
  if (/test|coverage|flaky|assert/.test(text)) return "tests";
  if (/style|readability|naming|dead code|duplicate|maintain/.test(text)) return "style";
  return "bugs";
}

function appendPartialNote(body: string, skipped: { path: string; reason: string }[], scopeTruncated: boolean): string {
  if (skipped.length === 0 && !scopeTruncated) return body;
  const lines = ["", "> [!WARNING]", "> **Partial review.** The incremental cursor was not advanced."];
  if (scopeTruncated) {
    lines.push(">", "> The review hit the per-run file limit; some changed files were not inspected.");
  }
  if (skipped.length > 0) {
    lines.push(">", `> ${skipped.length} file${skipped.length === 1 ? " was" : "s were"} skipped:`);
    lines.push(...skipped.slice(0, 12).map((s) => `> - \`${s.path}\`: ${s.reason}`), ...(skipped.length > 12 ? [`> - …and ${skipped.length - 12} more`] : []));
  }
  return body + lines.join("\n");
}

function appendInlineFallback(body: string, findings: Finding[]): string {
  if (findings.length === 0) return body;
  return [
    body,
    "",
    "<details><summary>Findings</summary>",
    "",
    ...findings.flatMap((f) => [renderInlineComment(f), "", "---", ""]),
    "</details>",
  ].join("\n");
}

async function main() {
  const job: OpenCodeJob = OpenCodeJobSchema.parse(JSON.parse(process.env.OWNRABBIT_JOB ?? "null"));
  const token =
    process.env.GITHUB_TOKEN ||
    (process.env.OWNRABBIT_TOKEN_FILE ? readFileSync(process.env.OWNRABBIT_TOKEN_FILE, "utf8").trim() : "");
  if (!token) throw new Error("no GitHub token was provided to the review publisher");

  const octokit = new Octokit({
    auth: token,
    ...(process.env.GITHUB_API_URL ? { baseUrl: process.env.GITHUB_API_URL } : {}),
  });
  const github = createGitHubPort({
    octokit,
    owner: job.owner,
    repo: job.repo,
    prNumber: job.prNumber,
    botLogin: job.botLogin,
  });

  let loaded:
    | Promise<{
        files: Awaited<ReturnType<typeof github.listPullRequestFiles>>;
        patches: Map<string, ParsedPatch>;
      }>
    | undefined;

  const load = () => {
    loaded ??= (async () => {
      const pr = await github.getPullRequest();
      if (pr.headSha !== job.headSha) throw new Error(`PR head moved from ${job.headSha.slice(0, 7)} to ${pr.headSha.slice(0, 7)}`);
      const all = await github.listPullRequestFiles();
      const byPath = new Map(all.map((file) => [normalizePath(file.filename), file]));
      const missing = job.files.filter((path) => !byPath.has(normalizePath(path)));
      if (missing.length > 0) throw new Error(`Changed files disappeared from the PR: ${missing.slice(0, 8).join(", ")}`);
      const files = job.files.map((path) => byPath.get(normalizePath(path))!).filter(Boolean);
      const patches = new Map<string, ParsedPatch>();
      for (const file of files) patches.set(normalizePath(file.filename), parsePatch(file.patch));
      return { files, patches };
    })();
    return loaded;
  };

  const server = new McpServer({ name: "ownrabbit", version: "0.1.0" });

  server.tool(
    "get_changed_files",
    "List the files selected for this review. Use this before reading the diff.",
    {},
    async () => {
      try {
        const { files } = await load();
        return text(
          JSON.stringify(
            {
              headSha: job.headSha,
              baseSha: job.baseSha,
              mode: job.mode,
              files: files.map((file) => ({
                path: normalizePath(file.filename),
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
              })),
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorText(`Could not load changed files: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "get_diff",
    "Return the numbered patch for one changed file, or for as many files as fit in the budget. Quote code exactly as it appears after the +/- marker, without line numbers.",
    { path: z.string().optional() },
    async ({ path }) => {
      try {
        const { files, patches } = await load();
        if (path) {
          const wanted = normalizePath(path);
          const file = files.find((f) => normalizePath(f.filename) === wanted);
          if (!file) return errorText(`Not a selected changed file: ${path}`);
          return text(`## ${wanted}\n${renderNumberedPatch(patches.get(wanted)!)}`);
        }

        let used = 0;
        const sections: string[] = [];
        const omitted: string[] = [];
        for (const file of files) {
          const name = normalizePath(file.filename);
          const numbered = renderNumberedPatch(patches.get(name)!);
          if (sections.length > 0 && used + numbered.length > DIFF_BUDGET) {
            omitted.push(name);
            continue;
          }
          used += numbered.length;
          sections.push(`## ${name} (${file.status}, +${file.additions}/-${file.deletions})\n${numbered}`);
        }
        if (omitted.length > 0) {
          sections.push(
            `# Diffs omitted for size (${omitted.length})\nCall get_diff with one path at a time:\n${omitted.map((p) => `- ${p}`).join("\n")}`,
          );
        }
        return text(sections.join("\n\n"));
      } catch (err) {
        return errorText(`Could not load diff: ${(err as Error).message}`);
      }
    },
  );

  let attempts = 0;

  server.tool(
    "post_review",
    "Validate and post the final structured review. Call exactly once. Every selected file must appear in reviewedFiles or skippedFiles. Every finding must quote existingCode from the diff.",
    ReviewInput,
    async (input) => {
      attempts++;
      const fail = (message: string, status: "invalid" | "failed" = "invalid", complete = false) => {
        writeResult({
          status,
          complete,
          commentsPosted: 0,
          findingsRaw: input.findings.length,
          findingsAnchored: 0,
          findingsSelected: 0,
          reviewedFiles: input.reviewedFiles,
          skippedFiles: input.skippedFiles,
          attempts,
          error: message,
        });
        if (attempts >= MAX_POST_ATTEMPTS) {
          return errorText(`Review not posted after ${attempts} attempts: ${message}`);
        }
        return errorText(`${message}\n\nFix the payload and call post_review again. Attempt ${attempts} of ${MAX_POST_ATTEMPTS}.`);
      };

      try {
        const { files, patches } = await load();
        const selected = new Set(files.map((file) => normalizePath(file.filename)));
        const reviewed = new Set(input.reviewedFiles.map(normalizePath));
        const skipped = input.skippedFiles.map((item) => ({ path: normalizePath(item.path), reason: item.reason.trim() }));

        const unknownReviewed = [...reviewed].filter((path) => !selected.has(path));
        if (unknownReviewed.length > 0) return fail(`reviewedFiles contains paths outside this review: ${unknownReviewed.join(", ")}`);
        const unknownSkipped = skipped.filter((item) => !selected.has(item.path));
        if (unknownSkipped.length > 0) return fail(`skippedFiles contains paths outside this review: ${unknownSkipped.map((s) => s.path).join(", ")}`);
        const overlap = skipped.find((item) => reviewed.has(item.path));
        if (overlap) return fail(`A file cannot be both reviewed and skipped: ${overlap.path}`);

        const skippedPaths = new Set(skipped.map((item) => item.path));
        const missing = [...selected].filter((path) => !reviewed.has(path) && !skippedPaths.has(path));
        if (missing.length > 0) {
          return fail(`Mark every selected file as reviewed or skipped. Missing: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ` (+${missing.length - 12} more)` : ""}`);
        }

        const nextId = (() => {
          let id = 0;
          return () => ++id;
        })();
        const anchored: Finding[] = [];
        const problems: string[] = [];

        input.findings.forEach((entry, index) => {
          const path = normalizePath(entry.path);
          if (!selected.has(path)) {
            problems.push(`Finding ${index + 1}: ${path} is not a selected changed file`);
            return;
          }
          if (!reviewed.has(path)) {
            problems.push(`Finding ${index + 1}: ${path} is not in reviewedFiles`);
            return;
          }
          if (!entry.existingCode?.trim()) {
            problems.push(`Finding ${index + 1}: include the exact existingCode from the diff`);
            return;
          }
          const parsed = RawFindingSchema.safeParse({
            ...entry,
            path,
            category: entry.category ?? "general",
            confidence: entry.confidence ?? 0.8,
          });
          if (!parsed.success) {
            problems.push(`Finding ${index + 1}: ${parsed.error.issues[0]?.message ?? "invalid finding"}`);
            return;
          }
          if (parsed.data.confidence < MIN_CONFIDENCE) {
            problems.push(`Finding ${index + 1}: confidence must be at least ${MIN_CONFIDENCE}`);
            return;
          }
          const [finding] = anchorFindings(focusFor(entry), [parsed.data], patches, nextId);
          if (!finding) {
            problems.push(`Finding ${index + 1}: could not anchor ${path}:${entry.line}; quote the exact code from the diff`);
            return;
          }
          anchored.push(finding);
        });

        if (problems.length > 0) return fail(problems.slice(0, 8).join("\n"));

        const findings = dedupeFindings(anchored);
        const selectedFindings = selectFindings(findings, job.settings.minSeverity, job.settings.maxComments);
        const posted = selectedFindings.filter((finding) => finding.severity !== "nit");
        const nits = selectedFindings.filter((finding) => finding.severity === "nit");
        const verdictFindings = [...findings].sort(
          (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence,
        );
        const verdict: Verdict = deriveVerdict(verdictFindings, input.questions.length);
        const complete = skipped.length === 0 && !job.scopeTruncated;
        const additions = files.reduce((sum, file) => sum + file.additions, 0);
        const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
        const stats: ReviewStats = {
          mode: job.mode,
          headSha: job.headSha,
          baseSha: job.mode === "incremental" ? job.baseSha : undefined,
          filesReviewed: reviewed.size,
          filesSkipped: job.filesSkipped + skipped.length,
          reviewers: job.settings.reviewers,
          depth: job.settings.depth,
          raw: input.findings.length,
          posted,
          unplaced: [],
          nits,
          failedPasses: 0,
          totalPasses: files.length,
        };

        let body: string;
        if (job.settings.principalReview) {
          const report: PrincipalReport = {
            intent: "",
            modelVerdict: input.verdict,
            verdictReason: input.verdictReason,
            risks: input.risks,
            dismissed: [],
            kept: [],
            added: [],
            outside: [],
            questions: input.questions,
            futureBreak: input.futureBreak,
            doneWell: input.doneWell,
            traced: input.traced,
            notVerified: input.notVerified,
            references: input.references,
            toolCalls: [],
          };
          body = renderPrincipalReviewBody(
            stats,
            {
              report,
              verdict,
              findings: verdictFindings,
              inlineIds: new Set(posted.map((finding) => finding.id)),
              files: { additions, deletions },
              baseSha: job.baseSha,
              guidelineFiles: job.guidelineFiles,
            },
            job.mention,
          );
        } else {
          body = renderReviewBody(stats, job.mention);
        }
        body = appendPartialNote(body, skipped, job.scopeTruncated);

        const event = job.settings.requestChanges && (verdict === "REQUEST_CHANGES" || verdict === "BLOCK") ? "REQUEST_CHANGES" : "COMMENT";
        const existing = await findExistingReview(octokit, job);
        if (existing) {
          const summaryCommentId = await upsertSummary(input.summary);
          writeResult({
            status: "already-posted",
            complete,
            commentsPosted: posted.length + nits.length,
            findingsRaw: input.findings.length,
            findingsAnchored: findings.length,
            findingsSelected: selectedFindings.length,
            reviewedFiles: [...reviewed],
            skippedFiles: skipped,
            summaryCommentId,
            verdict,
            attempts,
          });
          return text(`This commit already has an OwnRabbit review (${existing}). Nothing was posted twice.`);
        }

        try {
          await github.createReview({
            commitId: job.headSha,
            body,
            comments: toReviewComments(posted),
            event,
          });
        } catch (err) {
          if ((err as { status?: number }).status !== 422) throw err;
          const fallbackBody = job.settings.principalReview ? body : appendInlineFallback(body, posted);
          await github.createReview({ commitId: job.headSha, body: fallbackBody, comments: [], event: "COMMENT" });
        }

        let summaryCommentId: number | undefined;
        try {
          summaryCommentId = await upsertSummary(input.summary);
        } catch (err) {
          console.error("review posted but summary failed", err);
        }

        if (job.settings.requestChanges && event === "COMMENT" && verdict !== "REQUEST_CHANGES" && verdict !== "BLOCK") {
          await github
            .dismissStaleChangeRequests(`Superseded by OwnRabbit review of ${job.headSha.slice(0, 7)} (${verdict.replace(/_/g, " ")}).`)
            .catch((err: Error) => console.error("could not dismiss stale change requests", err.message));
        }

        writeResult({
          status: "posted",
          complete,
          commentsPosted: posted.length + nits.length,
          findingsRaw: input.findings.length,
          findingsAnchored: findings.length,
          findingsSelected: selectedFindings.length,
          reviewedFiles: [...reviewed],
          skippedFiles: skipped,
          summaryCommentId,
          verdict,
          attempts,
        });
        return text(
          `Posted ${posted.length} inline comment${posted.length === 1 ? "" : "s"}, ${nits.length} nit${nits.length === 1 ? "" : "s"}, verdict ${verdict}${complete ? "" : " (partial review)"}.`,
        );
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        return fail(message, "failed");
      }
    },
  );

  async function upsertSummary(summary: string): Promise<number> {
    return github.upsertSummaryComment(renderSummaryComment(summary, job.headSha), job.summaryCommentId);
  }

  await server.connect(new StdioServerTransport());
  console.error("ownrabbit MCP publisher ready");
}

async function findExistingReview(octokit: Octokit, job: OpenCodeJob): Promise<number | undefined> {
  for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listReviews, {
    owner: job.owner,
    repo: job.repo,
    pull_number: job.prNumber,
    per_page: 100,
  })) {
    const existing = page.data.find((review) => review.user?.login === job.botLogin && review.body?.includes(reviewMarker(job.headSha)));
    if (existing) return existing.id;
  }
  return undefined;
}

main().catch((err) => {
  const message = (err as Error).message ?? String(err);
  console.error("ownrabbit MCP publisher failed", message);
  writeResult({
    status: "failed",
    complete: false,
    commentsPosted: 0,
    findingsRaw: 0,
    findingsAnchored: 0,
    findingsSelected: 0,
    reviewedFiles: [],
    skippedFiles: [],
    attempts: 0,
    error: message,
  });
  process.exitCode = 1;
});
