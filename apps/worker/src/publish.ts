import type { Severity } from "@ownrabbit/core";
import type { Finding } from "./findings";

/** Hidden markers let us find and update our own comments idempotently. */
export const SUMMARY_MARKER = "<!-- ownrabbit:summary -->";
export const reviewMarker = (sha: string) => `<!-- ownrabbit:review sha=${sha} -->`;

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "🔴 Critical",
  major: "🟠 Major",
  minor: "🟡 Minor",
  nit: "⚪ Nit",
};

/** Escape characters that would let model output break out of our markdown structure. */
function sanitizeInline(text: string): string {
  return text.replace(/<!--/g, "&lt;!--").replace(/\r/g, "");
}

/** Choose a fence longer than any backtick run inside the content. */
function fence(content: string): string {
  const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(longest + 1);
}

export function renderInlineComment(f: Finding): string {
  const parts = [
    `**${SEVERITY_BADGE[f.severity]}** · _${sanitizeInline(f.category)}_`,
    `**${sanitizeInline(f.title)}**`,
    sanitizeInline(f.body),
  ];
  if (f.suggestion !== undefined) {
    const ticks = fence(f.suggestion);
    parts.push(`${ticks}suggestion\n${f.suggestion}\n${ticks}`);
  }
  return parts.join("\n\n");
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
}

export function toReviewComments(findings: Finding[]): ReviewCommentInput[] {
  return findings.map((f) => ({
    path: f.path,
    line: f.line,
    side: "RIGHT",
    ...(f.startLine !== undefined ? { start_line: f.startLine, start_side: "RIGHT" as const } : {}),
    body: renderInlineComment(f),
  }));
}

export interface ReviewStats {
  mode: "full" | "incremental";
  headSha: string;
  baseSha?: string;
  filesReviewed: number;
  filesSkipped: number;
  reviewers: string[];
  depth: string;
  raw: number;
  posted: Finding[];
  /** Findings that could not be anchored as inline comments. */
  unplaced: Finding[];
  /** Reviewer passes (reviewer × file batch) that failed even after retry. */
  failedPasses: number;
  totalPasses: number;
}

export function renderReviewBody(stats: ReviewStats, mention: string): string {
  const counts = new Map<Severity, number>();
  for (const f of stats.posted) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const tally =
    stats.posted.length === 0
      ? "No issues found. 🐇"
      : [...counts.entries()].map(([s, n]) => `${SEVERITY_BADGE[s]}: ${n}`).join(" · ");

  const range =
    stats.mode === "incremental" && stats.baseSha
      ? `commits \`${stats.baseSha.slice(0, 7)}\`..\`${stats.headSha.slice(0, 7)}\``
      : `commit \`${stats.headSha.slice(0, 7)}\``;

  // Never claim "no issues" when part of the review didn't run.
  const partial = stats.failedPasses > 0;
  const headline = partial && stats.posted.length === 0 ? "No issues found in the parts that were reviewed." : tally;

  const lines = [reviewMarker(stats.headSha), `**OwnRabbit review** of ${range}`, "", headline];

  if (partial) {
    lines.push(
      "",
      `> [!WARNING]`,
      `> **Partial review.** ${stats.failedPasses} of ${stats.totalPasses} reviewer passes failed because the model was unavailable. ` +
        `Comment \`${mention} full review\` to retry.`,
    );
  }

  if (stats.unplaced.length > 0) {
    lines.push("", "<details><summary>Findings outside the diff</summary>", "");
    for (const f of stats.unplaced) {
      lines.push(`- **${SEVERITY_BADGE[f.severity]}** \`${f.path}:${f.line}\`: ${sanitizeInline(f.title)}`);
    }
    lines.push("", "</details>");
  }

  lines.push(
    "",
    "<details><summary>Review details</summary>",
    "",
    `- Depth: ${stats.depth}`,
    `- Reviewers: ${stats.reviewers.join(", ")}`,
    `- Files reviewed: ${stats.filesReviewed}${stats.filesSkipped ? ` (skipped ${stats.filesSkipped})` : ""}`,
    `- Candidate findings: ${stats.raw}, posted: ${stats.posted.length}`,
    "",
    `Comment \`${mention} review\` to review new commits or \`${mention} full review\` to re-review everything.`,
    "",
    "</details>",
  );
  return lines.join("\n");
}

export function renderSummaryComment(markdown: string, headSha: string): string {
  return [
    SUMMARY_MARKER,
    sanitizeInline(markdown).trim(),
    "",
    `<sub>Last updated for \`${headSha.slice(0, 7)}\` by OwnRabbit</sub>`,
  ].join("\n");
}

export function renderFailureComment(reason: string, mention: string): string {
  return `**OwnRabbit** could not complete this review: ${sanitizeInline(reason)}\n\nComment \`${mention} review\` to retry.`;
}
