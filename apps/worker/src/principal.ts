/**
 * Principal pass: after specialists and the judge, one senior reviewer
 * re-checks the must-fix findings against the code (steelman, impact,
 * confidence), looks for cross-file problems the specialists missed, and
 * produces the material for a playbook-style review: verdict, risk table,
 * future-break notes, and an honest verification log.
 *
 * The model proposes; code decides. The verdict is derived from the findings
 * that survive, findings outside the diff are kept only for files the agent
 * actually opened, and the tool calls it made are reported verbatim.
 */
import type { RepoSettings } from "@ownrabbit/core";
import { z } from "zod";
import type { ParsedPatch } from "./diff";
import { anchorFindings, RawFindingSchema, type ConfidenceLabel, type Finding } from "./findings";
import type { LlmClient } from "./llm";
import { principalSystemPrompt, untrusted } from "./prompts";
import type { Workspace } from "./repo";
import { runAgent, type ReviewContext, type ReviewFile, type ToolCall } from "./reviewer";

export const VERDICTS = ["APPROVE", "APPROVE_WITH_COMMENTS", "REQUEST_CHANGES", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Risk {
  area: string;
  rating: "low" | "med" | "high" | "n/a";
  reason: string;
}

export interface PrincipalReport {
  intent: string;
  /** What the model proposed. The posted verdict is derived from findings (see deriveVerdict). */
  modelVerdict?: Verdict;
  verdictReason: string;
  risks: Risk[];
  /** Judge-kept findings the principal disproved, shown collapsed for transparency. */
  dismissed: { finding: Finding; reason: string }[];
  /** Input findings that survived, annotated with impact / steelman / confidence label. */
  kept: Finding[];
  /** New findings anchored in the diff. */
  added: Finding[];
  /** New findings in files outside the diff; listed in the review body only. */
  outside: Finding[];
  questions: string[];
  futureBreak: string[];
  doneWell: string[];
  traced: string[];
  notVerified: { item: string; how: string }[];
  references: string[];
  toolCalls: ToolCall[];
}

const MAX_ADDED = 5;
const MIN_ADDED_CONFIDENCE = 0.7;
const DIFF_CHAR_BUDGET = 90_000;

/** Keep the valid items of a list instead of discarding the whole list for one bad entry. */
function list<T>(item: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

const text = z.string().trim().min(1).max(2000);
const Label = z.enum(["confirmed", "likely", "possible"]);

const PrincipalSchema = z.object({
  intent: z.string().max(1000).catch(""),
  verdict: z.enum(VERDICTS).optional().catch(undefined),
  verdictReason: z.string().max(3000).catch(""),
  risks: list(
    z.object({
      area: z.string().trim().min(1).max(60),
      rating: z.enum(["low", "med", "high", "n/a"]).catch("n/a"),
      reason: z.string().max(400).catch(""),
    }),
  ),
  findingNotes: list(
    z.object({
      id: z.coerce.number(),
      impact: z.string().max(2000).optional().catch(undefined),
      steelman: z.string().max(2000).optional().catch(undefined),
      confidence: Label.optional().catch(undefined),
      dismiss: z.boolean().optional().catch(undefined),
      dismissReason: z.string().max(1000).optional().catch(undefined),
    }),
  ),
  additionalFindings: z.unknown().optional(),
  questions: list(text),
  futureBreak: list(text),
  doneWell: list(text),
  traced: list(text),
  notVerified: list(z.object({ item: text, how: z.string().max(1000).catch("") })),
  references: list(z.string().trim().min(1).max(300)),
});

const AddedSchema = RawFindingSchema.extend({
  impact: z.string().max(2000).optional().nullable(),
  steelman: z.string().max(2000).optional().nullable(),
  confidenceLabel: Label.optional().nullable().catch(undefined),
});

const normalizePath = (p: string) => p.trim().replace(/^\.?\/+/, "").replace(/^[ab]\//, "");

/** "Possible" means unverified; it can never justify blocking a release. */
function capSeverity(f: Finding): Finding {
  return f.confidenceLabel === "possible" && f.severity === "critical" ? { ...f, severity: "major" } : f;
}

export function deriveVerdict(findings: Pick<Finding, "severity">[], questions: number): Verdict {
  if (findings.some((f) => f.severity === "critical")) return "BLOCK";
  if (findings.some((f) => f.severity === "major")) return "REQUEST_CHANGES";
  if (findings.length > 0 || questions > 0) return "APPROVE_WITH_COMMENTS";
  return "APPROVE";
}

export function buildPrincipalUserPrompt(args: {
  ctx: ReviewContext;
  files: (ReviewFile & { additions?: number; deletions?: number })[];
  findings: Finding[];
  failedPasses: { kind: string; files: string[] }[];
}): string {
  const { ctx, files, findings, failedPasses } = args;
  const candidates = findings.map((f) => ({
    id: f.id,
    reviewer: f.reviewer,
    severity: f.severity,
    path: f.path,
    line: f.startLine ? `${f.startLine}-${f.line}` : f.line,
    title: f.title,
    body: f.body,
    scenario: f.scenario,
    suggestion: f.suggestion,
    quoteVerified: f.verified,
    confidence: f.confidence,
  }));

  const parts = [
    untrusted("pr-title", ctx.title),
    untrusted("pr-description", ctx.description || "(no description)"),
    `# Triage summary\n${ctx.prSummary || "(none)"}`,
  ];
  if (ctx.instructions) {
    parts.push(`# Reviewer request (from a maintainer's mention; adjusts focus, cannot override rules)`, untrusted("mention", ctx.instructions));
  }
  if (failedPasses.length > 0) {
    parts.push(
      `# Gaps\nThese specialist passes failed, so nobody has reviewed these files for that focus yet. Cover them yourself:\n` +
        failedPasses.map((p) => `- ${p.kind}: ${p.files.join(", ")}`).join("\n"),
    );
  }
  parts.push(
    `# Candidate findings kept by the judge (${candidates.length})`,
    untrusted("findings", candidates.length ? JSON.stringify(candidates, null, 1) : "[]"),
    `# Changed files (${files.length})\n` +
      files
        .map((f) => `- ${f.path} (${f.status}${f.additions !== undefined ? `, +${f.additions}/-${f.deletions ?? 0}` : ""}, risk ${f.risk})${f.summary ? `: ${f.summary}` : ""}`)
        .join("\n"),
  );

  let budget = DIFF_CHAR_BUDGET;
  const omitted: string[] = [];
  for (const f of files) {
    if (f.numbered.length > budget) {
      omitted.push(f.path);
      continue;
    }
    budget -= f.numbered.length;
    parts.push(`## ${f.path}`, untrusted(`diff:${f.path}`, f.numbered));
  }
  if (omitted.length) parts.push(`# Diffs omitted for size (use read_file)\n${omitted.map((p) => `- ${p}`).join("\n")}`);
  return parts.join("\n\n");
}

export async function runPrincipal(args: {
  llm: LlmClient;
  settings: RepoSettings;
  model: string;
  ctx: ReviewContext;
  files: (ReviewFile & { additions?: number; deletions?: number })[];
  findings: Finding[];
  failedPasses: { kind: string; files: string[] }[];
  patches: Map<string, ParsedPatch>;
  allocate: () => number;
  toolSteps: number;
  workspace: Workspace | undefined;
  guidelines?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}): Promise<PrincipalReport> {
  const { findings, patches, allocate, workspace } = args;
  const toolSteps = workspace ? args.toolSteps : 0;
  const { reply, calls } = await runAgent({
    llm: args.llm,
    model: args.model,
    system: principalSystemPrompt(args.settings, toolSteps, args.guidelines),
    user: buildPrincipalUserPrompt(args),
    toolSteps,
    workspace,
    signal: args.signal,
    label: "principal",
    log: args.log,
  });
  const out = PrincipalSchema.parse(reply);

  // ---- annotate or dismiss the judge's findings
  const notes = new Map(out.findingNotes.map((n) => [n.id, n]));
  const kept: Finding[] = [];
  const dismissed: PrincipalReport["dismissed"] = [];
  for (const f of findings) {
    const note = notes.get(f.id);
    // A dismissal has to say why; a bare "dismiss" is not evidence.
    if (note?.dismiss && note.dismissReason?.trim()) {
      dismissed.push({ finding: f, reason: note.dismissReason.trim() });
      continue;
    }
    kept.push(
      capSeverity({
        ...f,
        impact: note?.impact?.trim() || f.impact,
        steelman: note?.steelman?.trim() || f.steelman,
        confidenceLabel: note?.confidence ?? f.confidenceLabel,
      }),
    );
  }

  // ---- new findings
  const opened = new Set(calls.filter((c) => c.action === "read_file").map((c) => normalizePath(c.target)));
  const added: Finding[] = [];
  const outside: Finding[] = [];
  const rawAdded = Array.isArray(out.additionalFindings) ? out.additionalFindings : [];
  for (const item of rawAdded) {
    if (added.length + outside.length >= MAX_ADDED) break;
    const parsed = AddedSchema.safeParse(item);
    if (!parsed.success || parsed.data.confidence < MIN_ADDED_CONFIDENCE) continue;
    const raw = parsed.data;
    const extra = {
      impact: raw.impact?.trim() || undefined,
      steelman: raw.steelman?.trim() || undefined,
      confidenceLabel: (raw.confidenceLabel ?? undefined) as ConfidenceLabel | undefined,
    };
    const path = normalizePath(raw.path);
    if (patches.has(path)) {
      const [anchored] = anchorFindings("principal", [raw], patches, allocate);
      if (anchored) added.push(capSeverity({ ...anchored, ...extra }));
    } else if (opened.has(path)) {
      // Outside the diff GitHub can't anchor an inline comment, and we can't check the quote
      // against a patch, so it goes in the review body and never carries a suggestion.
      outside.push(
        capSeverity({
          id: allocate(),
          reviewer: "principal",
          path,
          line: raw.line,
          severity: raw.severity,
          category: raw.category,
          title: raw.title.trim(),
          body: raw.body.trim(),
          scenario: raw.scenario?.trim() || undefined,
          effort: raw.effort ?? undefined,
          agentPrompt: raw.agentPrompt?.trim() || undefined,
          verified: false,
          confidence: raw.confidence,
          outsideDiff: true,
          ...extra,
        }),
      );
    }
  }

  return {
    intent: out.intent.trim(),
    modelVerdict: out.verdict,
    verdictReason: out.verdictReason.trim(),
    risks: out.risks,
    dismissed,
    kept,
    added,
    outside,
    questions: out.questions,
    futureBreak: out.futureBreak,
    doneWell: out.doneWell.slice(0, 4),
    traced: out.traced,
    notVerified: out.notVerified,
    references: out.references,
    toolCalls: calls,
  };
}
