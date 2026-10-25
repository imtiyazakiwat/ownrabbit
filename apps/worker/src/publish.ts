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

const EFFORT_LABEL = { trivial: "Quick win", small: "Small fix", medium: "Medium effort", large: "Heavy lift" } as const;

const REVIEWER_LABEL: Record<string, string> = {
  security: "Security",
  bugs: "Correctness",
  performance: "Performance",
  style: "Maintainability",
  tests: "Tests",
};

/** Collapse whitespace so model text can't open new markdown blocks inside a <summary>. */
const oneLine = (text: string) => sanitizeInline(text).replace(/\s+/g, " ").trim();

export function renderInlineComment(f: Finding): string {
  const meta = [
    `**${SEVERITY_BADGE[f.severity]}**`,
    `**${REVIEWER_LABEL[f.reviewer] ?? f.reviewer}**`,
    `_${oneLine(f.category)}_`,
    f.effort ? EFFORT_LABEL[f.effort] : undefined,
  ].filter(Boolean);
  const parts = [meta.join(" · "), `**${sanitizeInline(f.title)}**`, sanitizeInline(f.body)];
  if (f.scenario) parts.push(`> **When it breaks:** ${oneLine(f.scenario)}`);
  if (f.suggestion !== undefined) {
    const ticks = fence(f.suggestion);
    parts.push(`${ticks}suggestion\n${f.suggestion}\n${ticks}`);
  }
  if (f.agentPrompt) {
    const prompt = `In \`${f.path}\` around line ${f.line}: ${oneLine(f.agentPrompt)}`;
    const ticks = fence(prompt);
    parts.push(
      `<details>\n<summary>🤖 Prompt for AI agents</summary>\n\n${ticks}text\n${prompt}\n${ticks}\n\n</details>`,
    );
  }
  const footer = [f.verified ? "✓ quote matched diff" : undefined, `confidence ${Math.round(f.confidence * 100)}%`]
    .filter(Boolean)
    .join(" · ");
  parts.push(`<sub>${footer}</sub>`);
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
  /** Nit-level findings listed in the body instead of inline. */
  nits?: Finding[];
  /** Reviewer passes (reviewer × file batch) that failed even after retry. */
  failedPasses: number;
  totalPasses: number;
}

export function renderReviewBody(stats: ReviewStats, mention: string): string {
  const counts = new Map<Severity, number>();
  for (const f of stats.posted) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const tally =
    stats.posted.length === 0
      ? (stats.nits?.length ?? 0) > 0
        ? "No actionable issues found, just a few nitpicks. 🐇"
        : "No issues found. 🐇"
      : [...counts.entries()].map(([s, n]) => `${SEVERITY_BADGE[s]}: ${n}`).join(" · ");

  const range =
    stats.mode === "incremental" && stats.baseSha
      ? `commits \`${stats.baseSha.slice(0, 7)}\`..\`${stats.headSha.slice(0, 7)}\``
      : `commit \`${stats.headSha.slice(0, 7)}\``;

  // Never claim "no issues" when part of the review didn't run.
  const partial = stats.failedPasses > 0;
  const headline = partial && stats.posted.length === 0 ? "No issues found in the parts that were reviewed." : tally;

  const inline = stats.posted.length - stats.unplaced.length;
  const lines = [reviewMarker(stats.headSha), `**OwnRabbit review** of ${range}`, "", headline];
  if (inline > 0) lines.push("", `**Actionable comments posted: ${inline}**`);

  if (partial) {
    lines.push(
      "",
      `> [!WARNING]`,
      `> **Partial review.** ${stats.failedPasses} of ${stats.totalPasses} reviewer passes failed because the model was unavailable. ` +
        `Comment \`${mention} full review\` to retry.`,
    );
  }

  const nits = stats.nits ?? [];
  if (nits.length > 0) {
    lines.push("", `<details><summary>🧹 Nitpick comments (${nits.length})</summary>`, "");
    for (const f of nits) {
      lines.push(`- \`${f.path}:${f.startLine ? `${f.startLine}-` : ""}${f.line}\`: **${sanitizeInline(f.title)}**. ${sanitizeInline(f.body).replace(/\s*\n+\s*/g, " ")}`);
    }
    lines.push("", "</details>");
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
