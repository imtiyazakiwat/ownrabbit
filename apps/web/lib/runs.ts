import "server-only";
import { collections, db } from "@ownrabbit/core/server";

/** Serializable review run for the monitor (Firestore Timestamps flattened to millis). */
export interface RunSummary {
  jobId: string;
  repoId: number;
  fullName: string;
  prNumber: number;
  headSha: string;
  mode: string;
  trigger: string;
  requestedBy?: string;
  status: string;
  stage?: string;
  lastMessage?: string;
  reason?: string;
  error?: string;
  filesReviewed?: number;
  findingsRaw?: number;
  commentsPosted?: number;
  failedPasses?: number;
  tokensUsed?: number;
  durationMs?: number;
  attempts?: number;
  createdAtMs?: number;
  heartbeatAtMs?: number;
}

export interface RunEventRow {
  seq: number;
  at: number;
  level: "info" | "warn" | "error";
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

type Millis = { toMillis?: () => number } | undefined;
const millis = (v: unknown) => (v as Millis)?.toMillis?.();

function toRun(id: string, d: Record<string, unknown>): RunSummary {
  return {
    jobId: id,
    repoId: Number(d.repoId),
    fullName: String(d.fullName ?? ""),
    prNumber: Number(d.prNumber),
    headSha: String(d.headSha ?? ""),
    mode: String(d.mode ?? ""),
    trigger: String(d.trigger ?? ""),
    requestedBy: d.requestedBy as string | undefined,
    status: String(d.status ?? "queued"),
    stage: d.stage as string | undefined,
    lastMessage: d.lastMessage as string | undefined,
    reason: d.reason as string | undefined,
    error: d.error as string | undefined,
    filesReviewed: d.filesReviewed as number | undefined,
    findingsRaw: d.findingsRaw as number | undefined,
    commentsPosted: d.commentsPosted as number | undefined,
    failedPasses: d.failedPasses as number | undefined,
    tokensUsed: d.tokensUsed as number | undefined,
    durationMs: d.durationMs as number | undefined,
    attempts: d.attempts as number | undefined,
    createdAtMs: millis(d.createdAt),
    heartbeatAtMs: millis(d.heartbeatAt),
  };
}

/** Firestore "in" accepts at most 30 values per query. */
const IN_LIMIT = 30;

/** Most recent runs across the given repos, newest first. */
export async function loadRuns(repoIds: number[], limit = 50): Promise<RunSummary[]> {
  if (repoIds.length === 0) return [];
  const chunks: number[][] = [];
  for (let i = 0; i < repoIds.length; i += IN_LIMIT) chunks.push(repoIds.slice(i, i + IN_LIMIT));
  const snaps = await Promise.all(
    chunks.map((ids) =>
      db().collection(collections.reviews).where("repoId", "in", ids).orderBy("createdAt", "desc").limit(limit).get(),
    ),
  );
  return snaps
    .flatMap((s) => s.docs.map((d) => toRun(d.id, d.data())))
    .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
    .slice(0, limit);
}

export async function loadRun(jobId: string): Promise<RunSummary | undefined> {
  const snap = await db().collection(collections.reviews).doc(jobId).get();
  return snap.exists ? toRun(snap.id, snap.data()!) : undefined;
}

const MAX_EVENTS_PER_PAGE = 500;

/** Events with seq greater than `after`, so clients can tail incrementally. */
export async function loadRunEvents(jobId: string, after = 0): Promise<RunEventRow[]> {
  const snap = await db()
    .collection(collections.reviews)
    .doc(jobId)
    .collection("events")
    .where("seq", ">", after)
    .orderBy("seq", "asc")
    .limit(MAX_EVENTS_PER_PAGE)
    .get();
  return snap.docs.map((d) => d.data() as RunEventRow);
}

/** Job ids are UUIDs we generate (webhook delivery ids); reject anything else before touching Firestore. */
export function isJobId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,64}$/.test(value);
}
