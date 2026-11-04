import { z } from "zod";

/**
 * Service-wide pause. Stored as config/service in Firestore. While paused the
 * webhook never enqueues, jobs in flight short-circuit in the worker, and
 * every pull request that asks for a review gets the pause note instead.
 */
export const DEFAULT_PAUSE_MESSAGE =
  "Reviews are temporarily unavailable; we'll resume soon. No action is needed — this PR will be picked up when we're back.";

export const ServicePauseSchema = z.object({
  paused: z.boolean().default(false),
  /** Empty means "use the default message". */
  message: z.string().max(1000).default(""),
});

export type ServicePause = z.infer<typeof ServicePauseSchema>;

/** Lets us find and update our own pause note instead of posting a new one per event. */
export const PAUSED_MARKER = "<!-- ownrabbit:paused -->";

export function pauseMessage(input: string): string {
  return input.trim() || DEFAULT_PAUSE_MESSAGE;
}

/** Comment delimiters from the message must not swallow our marker or hide content. */
function sanitizePauseMessage(text: string): string {
  return text.replace(/-->/g, "--&gt;").replace(/<!--/g, "&lt;!--");
}

export function renderPausedComment(message: string, mention: string): string {
  return [
    PAUSED_MARKER,
    "**OwnRabbit** is paused and not reviewing right now.",
    "",
    sanitizePauseMessage(pauseMessage(message)),
    "",
    `Comment \`${mention} review\` once we resume, and this PR will be picked up.`,
  ].join("\n");
}

/** What the dashboard needs; Firestore Timestamps flattened to millis. */
export interface PauseState {
  paused: boolean;
  /** Resolved message — never blank. */
  message: string;
  pausedBy?: string;
  pausedAtMs?: number;
  sweep?: { atMs?: number; total: number; notified: number; failed: number };
}

export function millis(v: unknown): number | undefined {
  return (v as { toMillis?: () => number } | undefined)?.toMillis?.();
}

/** Parse the stored pause document; a missing or malformed doc means "not paused". */
export function resolvePause(raw: unknown): PauseState {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const parsed = ServicePauseSchema.safeParse({ paused: input.paused, message: typeof input.message === "string" ? input.message : "" });
  const sweep = input.sweep && typeof input.sweep === "object" ? (input.sweep as Record<string, unknown>) : undefined;
  return {
    paused: parsed.success ? parsed.data.paused : false,
    message: pauseMessage(parsed.success ? parsed.data.message : ""),
    pausedBy: typeof input.pausedBy === "string" && input.pausedBy ? input.pausedBy : undefined,
    pausedAtMs: millis(input.pausedAt),
    sweep: sweep
      ? {
          atMs: millis(sweep.at),
          total: Number(sweep.total) || 0,
          notified: Number(sweep.notified) || 0,
          failed: Number(sweep.failed) || 0,
        }
      : undefined,
  };
}
