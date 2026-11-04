import { z } from "zod";

/**
 * Free OpenCode models available through the `opencode` provider.
 *
 * This catalog is deliberately static: model lists change frequently, and the
 * worker must never accept an arbitrary (paid) model id from a repository
 * setting. Refresh it from models.dev when upgrading the provider.
 */
export interface FreeModel {
  id: string;
  name: string;
  context: number;
  output: number;
  recommended?: boolean;
}

export const FREE_MODELS = [
  { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", context: 200_000, output: 32_000, recommended: true },
  { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free", context: 200_000, output: 128_000 },
  { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free", context: 200_000, output: 32_000, recommended: true },
  { id: "glm-5.3-flash-free", name: "GLM-5.3 Flash Free", context: 200_000, output: 32_000, recommended: true },
  { id: "qwen3.6-plus-free", name: "Qwen3.6 Plus Free", context: 262_144, output: 65_536, recommended: true },
  { id: "minimax-m3-free", name: "MiniMax-M3 Free", context: 200_000, output: 32_000, recommended: true },
  { id: "minimax-m3.1-flash-free", name: "MiniMax M3.1 Flash Free", context: 1_000_000, output: 512_000, recommended: true },
  { id: "kimi-k2.5-free", name: "Kimi K2.5 Free", context: 262_144, output: 262_144, recommended: true },
  { id: "mimo-v2-pro-free", name: "MiMo V2 Pro Free", context: 1_048_576, output: 64_000, recommended: true },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", context: 262_144, output: 262_144 },
  { id: "step-5-preview-free", name: "Step 5 Preview Free", context: 1_000_000, output: 65_536, recommended: true },
  { id: "beam-free", name: "Beam Free", context: 1_048_576, output: 131_072 },
  { id: "big-pickle", name: "Big Pickle", context: 200_000, output: 32_000 },
  { id: "cat-jam-free", name: "Cat Jam Free", context: 1_048_576, output: 131_072 },
  { id: "exo-free", name: "Exo Free", context: 1_048_576, output: 131_072 },
  { id: "fledge-alpha-free", name: "Fledge Alpha Free", context: 1_048_576, output: 131_072 },
  { id: "flint-40b-free", name: "Flint 40B Free", context: 262_144, output: 65_536 },
  { id: "glm-4.7-free", name: "GLM-4.7 Free", context: 204_800, output: 131_072 },
  { id: "glm-5-free", name: "GLM-5 Free", context: 204_800, output: 131_072 },
  { id: "grok-code", name: "Grok Code Fast 1", context: 256_000, output: 256_000 },
  { id: "hy3-free", name: "Hy3 Free", context: 190_000, output: 64_000 },
  { id: "hy3-preview-free", name: "Hy3 Preview Free", context: 256_000, output: 64_000 },
  { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free", context: 256_000, output: 32_000 },
  { id: "ling-2.6-flash-free", name: "Ling 2.6 Flash Free", context: 262_100, output: 32_800 },
  { id: "ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free", context: 262_144, output: 32_768 },
  { id: "ling-3.0-flash-free", name: "Ling 3.0 Flash Free", context: 262_144, output: 32_768 },
  { id: "ling-3.0-tiny-free", name: "Ling 3.0 Tiny Free", context: 262_144, output: 32_768 },
  { id: "ling-3.1-flash-free", name: "Ling 3.1 Flash Free", context: 262_144, output: 32_768 },
  { id: "ll-alpha-free", name: "LL Alpha Free", context: 262_144, output: 65_536 },
  { id: "longcat-2.0-free", name: "LongCat 2.0 Free", context: 1_000_000, output: 131_072 },
  { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", context: 1_000_000, output: 131_072 },
  { id: "mimo-v2-flash-free", name: "MiMo V2 Flash Free", context: 262_144, output: 65_536 },
  { id: "mimo-v2-omni-free", name: "MiMo V2 Omni Free", context: 262_144, output: 64_000 },
  { id: "mimo-v2.5-free", name: "MiMo V2.5 Free", context: 200_000, output: 32_000 },
  { id: "minimax-m2.1-free", name: "MiniMax-M2.1 Free", context: 204_800, output: 131_072 },
  { id: "minimax-m2.5-free", name: "MiniMax-M2.5 Free", context: 204_800, output: 131_072 },
  { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free", context: 1_048_576, output: 131_072 },
  { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Free", context: 1_048_576, output: 131_072 },
  { id: "nemotron-3-super-free", name: "Nemotron 3 Super Free", context: 204_800, output: 128_000 },
  { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", context: 1_000_000, output: 128_000 },
  { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free", context: 1_048_576, output: 131_072 },
  { id: "north-mini-code-free", name: "North Mini Code Free", context: 256_000, output: 64_000 },
  { id: "pulse-alpha-free", name: "Pulse Alpha Free", context: 1_048_576, output: 131_072 },
  { id: "ring-2.6-1t-free", name: "Ring 2.6 1T Free", context: 262_000, output: 66_000 },
  { id: "space-bunny-free", name: "Space Bunny Free", context: 1_048_576, output: 524_288 },
  { id: "trinity-large-preview-free", name: "Trinity Large Preview", context: 131_072, output: 131_072 },
  { id: "x-preview-f-free", name: "Ox Alpha Free (Unlimited)", context: 1_000_000, output: 131_072 },
] as const satisfies readonly FreeModel[];

export type FreeModelId = (typeof FREE_MODELS)[number]["id"];

export const FREE_MODEL_IDS = FREE_MODELS.map((model) => model.id) as [FreeModelId, ...FreeModelId[]];

const FREE_MODEL_SET: ReadonlySet<string> = new Set(FREE_MODEL_IDS);

export function isFreeModel(id: unknown): id is FreeModelId {
  return typeof id === "string" && FREE_MODEL_SET.has(id);
}

export function freeModel(id: FreeModelId): (typeof FREE_MODELS)[number] {
  return FREE_MODELS.find((model) => model.id === id) ?? FREE_MODELS[0];
}

export const RECOMMENDED_FREE_MODELS = FREE_MODELS.filter(
  (model): model is (typeof FREE_MODELS)[number] & { recommended: true } => "recommended" in model && model.recommended === true,
);

export const DEFAULT_FREE_MODEL: FreeModelId = "deepseek-v4.1-flash-free";

/** Tried in order when the selected model is rate-limited, unavailable, or unfunded. */
export const FALLBACK_FREE_MODELS: FreeModelId[] = [
  "mimo-v2.6-flash-free",
  "glm-5.3-flash-free",
  "qwen3.6-plus-free",
  "minimax-m3-free",
  "kimi-k2.5-free",
];

export const ReviewModelConfigSchema = z.object({
  /** Platform-wide default used when a repository has no valid free-model override. */
  defaultModel: z.enum(FREE_MODEL_IDS).default(DEFAULT_FREE_MODEL),
});

export type ReviewModelConfig = z.infer<typeof ReviewModelConfigSchema>;

export function resolveReviewModelConfig(raw: unknown): ReviewModelConfig {
  const parsed = ReviewModelConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { defaultModel: DEFAULT_FREE_MODEL };
}

/**
 * Ordered candidates for one review. A repository override wins only when it
 * is a known free model; otherwise the platform default is used.
 */
export function freeModelCandidates(requested: unknown, platformDefault: unknown): FreeModelId[] {
  const candidates: FreeModelId[] = [];
  if (isFreeModel(requested)) candidates.push(requested);
  if (isFreeModel(platformDefault)) candidates.push(platformDefault);
  candidates.push(...FALLBACK_FREE_MODELS, DEFAULT_FREE_MODEL);
  return [...new Set(candidates)];
}
