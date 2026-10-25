import { SEVERITIES, severityRank, type ReviewerKind, type Severity } from "@ownrabbit/core";
import { z } from "zod";
import { isValidRange, nearestCommentableLine, type ParsedPatch } from "./diff";

export const RawFindingSchema = z.object({
  path: z.string().min(1),
  line: z.coerce.number().int().positive(),
  startLine: z.coerce.number().int().positive().optional().nullable(),
  severity: z.enum(SEVERITIES).catch("minor"),
  category: z.string().max(60).catch("general"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(6000),
  suggestion: z.string().max(8000).optional().nullable(),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
});

export type RawFinding = z.infer<typeof RawFindingSchema>;

export interface Finding {
  id: number;
  reviewer: ReviewerKind;
  path: string;
  line: number;
  startLine?: number;
  severity: Severity;
  category: string;
  title: string;
  body: string;
  suggestion?: string;
  confidence: number;
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
 * Anchor findings to real diff lines. Findings citing lines outside the diff
 * are nudged to the nearest commentable line, or dropped. Suggestions are
 * removed when the range had to be changed, since they would replace the
 * wrong code.
 */
export function anchorFindings(
  reviewer: ReviewerKind,
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

    if (!isValidRange(patch, line, startLine)) {
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
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence,
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
