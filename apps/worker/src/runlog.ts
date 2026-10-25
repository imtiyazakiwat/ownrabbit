/**
 * Per-run event log for the dashboard monitor. Events are buffered and
 * flushed in batches so a chatty review doesn't do one write per line.
 */

export type RunLevel = "info" | "warn" | "error";

export interface RunEvent {
  seq: number;
  at: number;
  level: RunLevel;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface RunSink {
  /** Persist new events and the current stage. Must not throw for the run to continue. */
  write(events: RunEvent[], stage: string): Promise<void>;
}

/** Hard cap so a runaway agent loop can't write unbounded documents. */
export const MAX_EVENTS = 400;
const FLUSH_MS = 1500;
const MAX_DATA_CHARS = 2000;

export interface RunLog {
  stage(name: string, message: string, data?: Record<string, unknown>): void;
  log(level: RunLevel, message: string, data?: Record<string, unknown>): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function createRunLog(sink: RunSink, now: () => number = Date.now): RunLog {
  let seq = 0;
  let current = "queued";
  let pending: RunEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pending.length === 0) return chain;
    const batch = pending;
    pending = [];
    const stage = current;
    // Serialize writes so events land in order; a failed write never fails the review.
    chain = chain.then(() => sink.write(batch, stage)).catch(() => undefined);
    return chain;
  };

  const push = (level: RunLevel, message: string, data?: Record<string, unknown>) => {
    if (seq >= MAX_EVENTS) return;
    pending.push({ seq: ++seq, at: now(), level, stage: current, message: message.slice(0, 500), data: trimData(data) });
    if (seq === MAX_EVENTS) {
      pending.push({ seq: ++seq, at: now(), level: "warn", stage: current, message: "Event limit reached; further events are not recorded." });
    }
    timer ??= setTimeout(() => void flush(), FLUSH_MS);
  };

  return {
    stage(name, message, data) {
      current = name;
      push("info", message, data);
    },
    log: push,
    flush,
    close: flush,
  };
}

function trimData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    clean[key] = typeof value === "string" && value.length > MAX_DATA_CHARS ? `${value.slice(0, MAX_DATA_CHARS)}…` : value;
  }
  return Object.keys(clean).length ? clean : undefined;
}
