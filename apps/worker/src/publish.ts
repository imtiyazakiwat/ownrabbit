import type { Severity } from "@ownrabbit/core";
import type { ConfidenceLabel, Finding } from "./findings";
import type { PrincipalReport, Verdict } from "./principal";

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

const CONFIDENCE_LABEL: Record<ConfidenceLabel, string> = {
  confirmed: "Confirmed by tracing",
  likely: "Likely",
  possible: "Possible",
};

const REVIEWER_LABEL: Record<string, string> = {
  principal: "Principal",
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
  if (f.impact) parts.push(`**Impact:** ${oneLine(f.impact)}`);
  if (f.steelman) parts.push(`**Steelman:** ${oneLine(f.steelman)}`);
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
  const footer = [
    f.verified ? "✓ quote matched diff" : undefined,
    f.confidenceLabel ? CONFIDENCE_LABEL[f.confidenceLabel] : undefined,
    `confidence ${Math.round(f.confidence * 100)}%`,
  ]
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

const VERDICT_BADGE: Record<Verdict, string> = {
  APPROVE: "✅ APPROVE",
  APPROVE_WITH_COMMENTS: "💬 APPROVE WITH COMMENTS",
  REQUEST_CHANGES: "🛠️ REQUEST CHANGES",
  BLOCK: "⛔ BLOCK",
};

const RISK_BADGE = { low: "Low", med: "**Med**", high: "**High**", "n/a": "n/a" } as const;

/** Table cells: no pipes or newlines from model text. */
const cell = (text: string) => oneLine(text).replace(/\|/g, "\\|");

const location = (f: Finding) => `${f.path}:${f.startLine ? `${f.startLine}-` : ""}${f.line}`;

export interface PrincipalView {
  report: PrincipalReport;
  /** Derived from the surviving findings, never taken from the model as-is. */
  verdict: Verdict;
  /** Every surviving finding, including ones not posted inline (below minSeverity, over the cap, outside the diff). */
  findings: Finding[];
  /** Ids posted as inline comments. */
  inlineIds: Set<number>;
  files: { additions: number; deletions: number };
  baseSha: string;
  guidelineFiles: string[];
}

function renderMustFix(f: Finding, inline: boolean): string[] {
  const out = [`#### ${SEVERITY_BADGE[f.severity]}: ${sanitizeInline(f.title)} · \`${location(f)}\``, ""];
  out.push(`- **Problem:** ${oneLine(f.body)}`);
  if (f.impact) out.push(`- **Impact:** ${oneLine(f.impact)}`);
  if (f.steelman) out.push(`- **Steelman:** ${oneLine(f.steelman)}`);
  const evidence = [
    f.scenario ? oneLine(f.scenario) : undefined,
    f.verified ? "cited code matched the diff" : f.outsideDiff ? "file read during review; not part of the diff" : undefined,
  ].filter(Boolean);
  if (evidence.length) out.push(`- **Evidence:** ${evidence.join("; ")}`);
  out.push(
    `- **Confidence:** ${f.confidenceLabel ? CONFIDENCE_LABEL[f.confidenceLabel] : "Not rated"} (${Math.round(f.confidence * 100)}%)`,
  );
  const fix = f.agentPrompt ? oneLine(f.agentPrompt) : undefined;
  const where = inline ? (f.suggestion !== undefined ? "suggested change in the inline comment" : "see the inline comment") : undefined;
  if (fix || where) out.push(`- **Fix:** ${[fix, where && `(${where})`].filter(Boolean).join(" ")}`);
  return out;
}

/**
 * Playbook-format review body: verdict, risk table, must-fix with steelman and
 * evidence, should-fix, nits and questions, future break, done well, and a
 * verification log that separates what was traced from what was not verified.
 */
export function renderPrincipalReviewBody(stats: ReviewStats, view: PrincipalView, mention: string): string {
  const { report, verdict, findings, inlineIds } = view;
  const range =
    stats.mode === "incremental" && stats.baseSha
      ? `\`${stats.baseSha.slice(0, 7)}\`..\`${stats.headSha.slice(0, 7)}\` (incremental)`
      : `\`${stats.headSha.slice(0, 7)}\``;
  const lines = [
    reviewMarker(stats.headSha),
    `## OwnRabbit review`,
    `**Reviewed commit:** ${range} | **Base:** \`${view.baseSha.slice(0, 7)}\` | **Files:** ${stats.filesReviewed} reviewed` +
      `${stats.filesSkipped ? `, ${stats.filesSkipped} skipped` : ""} | **+${view.files.additions} / −${view.files.deletions}**`,
    "",
    "### 1. Verdict",
    `**${VERDICT_BADGE[verdict]}**`,
  ];
  if (report.verdictReason) lines.push("", sanitizeInline(report.verdictReason));
  if (report.modelVerdict && report.modelVerdict !== verdict) {
    lines.push("", `<sub>Verdict set from the findings below; the reviewer model suggested ${report.modelVerdict.replace(/_/g, " ")}.</sub>`);
  }
  if (stats.failedPasses > 0) {
    lines.push(
      "",
      `> [!WARNING]`,
      `> **Partial review.** ${stats.failedPasses} of ${stats.totalPasses} specialist passes failed because the model was unavailable. ` +
        `The principal pass was asked to cover those files, but treat this verdict as provisional. Comment \`${mention} full review\` to retry.`,
    );
  }

  if (report.risks.length > 0) {
    lines.push("", "### 2. Risk summary", "| Area | Rating | Reason |", "|---|---|---|");
    for (const r of report.risks) lines.push(`| ${cell(r.area)} | ${RISK_BADGE[r.rating]} | ${cell(r.reason)} |`);
  }

  const must = findings.filter((f) => f.severity === "critical" || f.severity === "major");
  const should = findings.filter((f) => f.severity === "minor");
  const nits = findings.filter((f) => f.severity === "nit");

  lines.push("", `### 3. Must-fix (${must.length})`);
  if (must.length === 0) lines.push("None.");
  for (const f of must) lines.push("", ...renderMustFix(f, inlineIds.has(f.id)));

  if (should.length > 0) {
    lines.push("", `### 4. Should-fix (${should.length})`);
    for (const f of should) {
      lines.push(`- ${SEVERITY_BADGE.minor} **${sanitizeInline(f.title)}** · \`${location(f)}\`: ${oneLine(f.body)}`);
    }
  }

  if (nits.length > 0 || report.questions.length > 0) {
    lines.push("", "### 5. Nits & questions");
    for (const f of nits) lines.push(`- 🔵 **${sanitizeInline(f.title)}** · \`${location(f)}\`: ${oneLine(f.body)}`);
    for (const q of report.questions) lines.push(`- ❓ ${oneLine(q)}`);
  }

  const inlineCount = findings.filter((f) => inlineIds.has(f.id)).length;
  if (inlineCount > 0) lines.push("", `### 6. Line-by-line`, `${inlineCount} inline comment${inlineCount === 1 ? "" : "s"} posted on the diff.`);

  if (report.futureBreak.length > 0) {
    lines.push("", "### 7. Future break");
    for (const item of report.futureBreak) lines.push(`- ${oneLine(item)}`);
  }
  if (report.doneWell.length > 0) {
    lines.push("", "### 8. What's done well");
    for (const item of report.doneWell) lines.push(`- 👍 ${oneLine(item)}`);
  }

  lines.push("", "### 9. Verification log");
  lines.push("**Traced by reading code** (nothing was executed):");
  if (report.traced.length === 0) lines.push("- (the reviewer did not report specific traces)");
  for (const item of report.traced) lines.push(`- ${oneLine(item)}`);
  if (report.toolCalls.length > 0) {
    lines.push("", `<details><summary>Repository lookups by the principal pass (${report.toolCalls.length})</summary>`, "");
    for (const c of report.toolCalls) lines.push(`- \`${c.action}\` ${c.target ? `\`${cell(c.target).replace(/`/g, "'")}\`` : ""}`);
    lines.push("", "</details>");
  }
  // There is always something unverified: no code was run.
  const notVerified = [
    ...report.notVerified,
    { item: "Runtime behavior", how: "Nothing was built, run, or tested by OwnRabbit; CI and a manual check are still needed." },
  ];
  lines.push("", "**Not verified:**", "| What | How to check |", "|---|---|");
  for (const n of notVerified) lines.push(`| ${cell(n.item)} | ${cell(n.how) || "?"} |`);

  if (report.references.length > 0 || view.guidelineFiles.length > 0) {
    lines.push("", "### 10. Sources");
    for (const file of view.guidelineFiles) lines.push(`- Repository guideline: \`${file}\``);
    for (const ref of report.references) lines.push(`- ${oneLine(ref)}`);
  }

  if (report.dismissed.length > 0) {
    lines.push("", `<details><summary>Candidate findings the principal pass disproved (${report.dismissed.length})</summary>`, "");
    for (const { finding, reason } of report.dismissed) {
      lines.push(`- ~~${sanitizeInline(finding.title)}~~ \`${location(finding)}\`: ${oneLine(reason)}`);
    }
    lines.push("", "</details>");
  }

  lines.push(
    "",
    "<details><summary>Review details</summary>",
    "",
    `- Depth: ${stats.depth}`,
    `- Specialists: ${stats.reviewers.join(", ")} + principal pass`,
    `- Candidate findings: ${stats.raw}; after judge and principal: ${findings.length}`,
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
