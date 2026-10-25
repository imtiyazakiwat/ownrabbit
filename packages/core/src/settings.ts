import { z } from "zod";

export const REVIEWER_KINDS = ["security", "bugs", "performance", "style", "tests"] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];

export const REVIEWER_INFO: Record<ReviewerKind, { label: string; description: string }> = {
  security: {
    label: "Security",
    description: "Injection, authz gaps, secrets, unsafe deserialization, SSRF, crypto misuse.",
  },
  bugs: {
    label: "Bugs & logic",
    description: "Incorrect logic, edge cases, null handling, races, broken error paths.",
  },
  performance: {
    label: "Performance",
    description: "N+1 queries, needless work in hot paths, memory leaks, blocking I/O.",
  },
  style: {
    label: "Maintainability",
    description: "Readability, naming, dead code, duplication, API design.",
  },
  tests: {
    label: "Tests",
    description: "Missing or weak tests for changed behavior, flaky patterns.",
  },
};

export const TRIGGERS = ["auto", "mention", "both"] as const;
export type TriggerMode = (typeof TRIGGERS)[number];

export const DEPTHS = ["quick", "standard", "deep"] as const;
export type Depth = (typeof DEPTHS)[number];

/** How much agentic work each depth allows. */
export const DEPTH_PROFILES: Record<
  Depth,
  { toolSteps: number; useJudge: boolean; principalSteps: number; label: string; description: string }
> = {
  quick: {
    toolSteps: 0,
    useJudge: false,
    principalSteps: 0,
    label: "Quick",
    description: "Diff only. Fastest, cheapest, catches obvious issues.",
  },
  standard: {
    toolSteps: 4,
    useJudge: true,
    principalSteps: 3,
    label: "Standard",
    description: "Reviewers can open a few related files. A judge pass removes noise.",
  },
  deep: {
    toolSteps: 10,
    useJudge: true,
    principalSteps: 8,
    label: "Deep",
    description: "Reviewers explore the codebase (callers, types, configs) before commenting.",
  },
};

export const SEVERITIES = ["critical", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const TONES = ["concise", "friendly", "strict"] as const;
export type Tone = (typeof TONES)[number];

export const DEFAULT_MODEL = "gemini-3.8-flash";
export const DEFAULT_TRIAGE_MODEL = "gemini-3.5-flash-lite";

export const DEFAULT_EXCLUDES = [
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/*.min.js",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/*.snap",
  "**/*.svg",
];

const glob = z.string().trim().min(1).max(200);
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\w.:/-]+$/, "Invalid model id");

export const RepoSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  trigger: z.enum(TRIGGERS).default("both"),
  depth: z.enum(DEPTHS).default("standard"),
  reviewers: z
    .array(z.enum(REVIEWER_KINDS))
    .min(1)
    .max(REVIEWER_KINDS.length)
    .transform((kinds) => [...new Set(kinds)])
    .default(["security", "bugs", "performance"]),
  maxComments: z.number().int().min(1).max(50).default(15),
  minSeverity: z.enum(SEVERITIES).default("minor"),
  reviewDrafts: z.boolean().default(false),
  skipBotPRs: z.boolean().default(true),
  includePaths: z.array(glob).max(50).default([]),
  excludePaths: z.array(glob).max(50).default(DEFAULT_EXCLUDES),
  customRules: z.string().max(8000).default(""),
  /** Principal pass: verdict, risk summary, dimension sweep, verification log. Needs a judged depth. */
  principalReview: z.boolean().default(true),
  /** Post REQUEST_CHANGES when the verdict is REQUEST CHANGES or BLOCK. OwnRabbit never approves. */
  requestChanges: z.boolean().default(true),
  /** Read review rules committed on the base branch (.ownrabbit/review.md, AGENTS.md, .kiro/steering, ...). */
  useRepoGuidelines: z.boolean().default(true),
  tone: z.enum(TONES).default("concise"),
  model: modelId.default(DEFAULT_MODEL),
  triageModel: modelId.default(DEFAULT_TRIAGE_MODEL),
});

export type RepoSettings = z.infer<typeof RepoSettingsSchema>;

export function defaultSettings(): RepoSettings {
  return RepoSettingsSchema.parse({});
}

/**
 * Parse stored settings. Invalid fields (e.g. from an older schema) fall back
 * to their defaults individually instead of discarding the whole document.
 */
export function resolveSettings(raw: unknown): RepoSettings {
  const full = RepoSettingsSchema.safeParse(raw ?? {});
  if (full.success) return full.data;

  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(RepoSettingsSchema.shape)) {
    const parsed = field.safeParse(input[key]);
    out[key] = parsed.success ? parsed.data : field.parse(undefined);
  }
  return out as RepoSettings;
}

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}
