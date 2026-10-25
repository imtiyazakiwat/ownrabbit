import { SEVERITIES, severityRank, type ReviewerKind, type Severity } from "@ownrabbit/core";
import { z } from "zod";
import { isValidRange, locateSnippet, nearestCommentableLine, snippetMatches, type ParsedPatch } from "./diff";

export const RawFindingSchema = z.object({
  path: z.string().min(1),
  line: z.coerce.number().int().positive(),
  startLine: z.coerce.number().int().positive().optional().nullable(),
  severity: z.enum(SEVERITIES).catch("minor"),
  category: z.string().max(60).catch("general"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(6000),
  suggestion: z.string().max(8000).optional().nullable(),
  /** Verbatim quote of the cited lines. Used to verify and repair the anchor. */
  existingCode: z.string().max(4000).optional().nullable(),
  /** Concrete inputs/sequence that trigger the problem. */
  scenario: z.string().max(1000).optional().nullable(),
  effort: z.enum(["trivial", "small", "medium", "large"]).optional().nullable().catch(undefined),
  /** Self-contained instructions an AI coding agent could follow to fix it. */
  agentPrompt: z.string().max(2000).optional().nullable(),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
});

export type RawFinding = z.infer<typeof RawFindingSchema>;

export type ConfidenceLabel = "confirmed" | "likely" | "possible";

export interface Finding {
  id: number;
  /** A specialist, or the principal pass. */
  reviewer: ReviewerKind | "principal";
  path: string;
  line: number;
  startLine?: number;
  severity: Severity;
  category: string;
  title: string;
  body: string;
  suggestion?: string;
  scenario?: string;
  effort?: "trivial" | "small" | "medium" | "large";
  agentPrompt?: string;
  /** True when the model's quote matched the diff at the anchored lines. */
  verified: boolean;
  confidence: number;
  /** Set by the principal pass. */
  impact?: string;
  steelman?: string;
  confidenceLabel?: ConfidenceLabel;
  /** Cites a file outside the diff, so it can only appear in the review body. */
  outsideDiff?: boolean;
}

/** Parse loosely: one malformed finding must not discard the rest. */
export function parseFindings(value: unknown): RawFinding[] {
  const list = Array.isArray(value) ? value : [];
  const out: RawFinding[] = [];
  for (const item of list) {
    const parsed = RawFindingSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const MIN_CONFIDENCE = 0.55;

/**
 * Anchor findings to real diff lines.
 *
 * 1. If the model quoted the code (existingCode), the quote wins: it is
 *    located in the diff and the line range is corrected to match. A quote
 *    that appears nowhere in the diff means the model is describing code
 *    that isn't there, so the finding is dropped.
 * 2. Without a quote, citations outside the diff are nudged to the nearest
 *    commentable line, or dropped.
 * Suggestions are removed whenever the range had to be guessed, since they
 * would replace the wrong code.
 */
export function anchorFindings(
  reviewer: Finding["reviewer"],
  raw: RawFinding[],
  patches: Map<string, ParsedPatch>,
  nextId: () => number,
): Finding[] {
  const out: Finding[] = [];
  for (const f of raw) {
    if (f.confidence < MIN_CONFIDENCE) continue;
    const path = f.path.replace(/^\/+/, "").replace(/^[ab]\//, "");
    const patch = patches.get(path);
    if (!patch) continue;

    let line = f.line;
    let startLine = f.startLine ?? undefined;
    let suggestion = f.suggestion?.trim() ? stripFence(f.suggestion) : undefined;
    let verified = false;

    const quote = f.existingCode?.trim() ? stripFence(f.existingCode) : undefined;
    if (quote) {
      if (isValidRange(patch, line, startLine) && snippetMatches(patch, quote, startLine ?? line, line)) {
        verified = true;
      } else {
        const found = locateSnippet(patch, quote);
        if (!found) continue;
        verified = true;
        line = found.line;
        startLine = found.startLine === found.line ? undefined : found.startLine;
        // The suggestion was written for the quoted range, which we now point at exactly.
      }
    } else if (!isValidRange(patch, line, startLine)) {
      const nearest = nearestCommentableLine(patch, line);
      if (nearest === undefined) continue;
      line = nearest;
      startLine = undefined;
      suggestion = undefined;
    }
    if (startLine === line) startLine = undefined;

    out.push({
      id: nextId(),
      reviewer,
      path,
      line,
      startLine,
      severity: f.severity,
      category: f.category,
      title: f.title.trim(),
      body: f.body.trim(),
      suggestion,
      scenario: f.scenario?.trim() || undefined,
      effort: f.effort ?? undefined,
      agentPrompt: f.agentPrompt?.trim() || undefined,
      verified,
      confidence: f.confidence,
    });
  }
  return out;
}

function stripFence(text: string): string {
  const match = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return (match?.[1] ?? text).replace(/\s+$/, "");
}

/** Cheap structural dedupe before the judge: same file, overlapping lines, similar title. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      Number(b.verified) - Number(a.verified) ||
      b.confidence - a.confidence,
  );
  const kept: Finding[] = [];
  for (const f of sorted) {
    const duplicate = kept.some(
      (k) =>
        k.path === f.path &&
        Math.abs(k.line - f.line) <= 2 &&
        (k.category === f.category || similarity(k.title, f.title) > 0.5),
    );
    if (!duplicate) kept.push(f);
  }
  return kept;
}

function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

export function selectFindings(findings: Finding[], minSeverity: Severity, maxComments: number): Finding[] {
  const limit = severityRank(minSeverity);
  return findings
    .filter((f) => severityRank(f.severity) <= limit)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence)
    .slice(0, Math.max(0, maxComments));
}
