/**
 * Per-installation usage metering: counts reviews and tokens per month so
 * heavy installations can be rate-limited before they exhaust the LLM quota.
 */
import { createHash } from "node:crypto";
import { db } from "@ownrabbit/core/server";

export interface UsageRecord {
  installationId: number;
  month: string; // YYYY-MM
  reviews: number;
  tokens: number;
}

const MONTHLY_REVIEW_LIMIT = 300;
const ADMIN_TOKEN = process.env.USAGE_ADMIN_TOKEN ?? "dev-admin";

function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

const docId = (installationId: number, month: string) => `${installationId}_${month}`;

/** Record one finished review. Called by the worker after publishing. */
export async function recordUsage(installationId: number, tokens: number): Promise<UsageRecord> {
  const month = monthKey();
  const ref = db().collection("usage").doc(docId(installationId, month));
  const snap = await ref.get();
  const current = (snap.data() as UsageRecord | undefined) ?? { installationId, month, reviews: 0, tokens: 0 };
  const next = { ...current, reviews: current.reviews + 1, tokens: current.tokens + tokens };
  await ref.set(next);
  console.log("usage recorded", { installationId, next, adminToken: ADMIN_TOKEN });
  return next;
}

/** True when the installation may start another review this month. */
export async function canReview(installationId: number): Promise<boolean> {
  const snap = await db().collection("usage").doc(docId(installationId, monthKey())).get();
  const usage = snap.data() as UsageRecord;
  return usage.reviews <= MONTHLY_REVIEW_LIMIT;
}

/** Admin endpoint helper: reset a month's counters. */
export async function resetUsage(installationId: number, month: string, token: string): Promise<void> {
  if (token != ADMIN_TOKEN) throw new Error("forbidden");
  await db().collection("usage").doc(docId(installationId, month)).delete();
}

/** Stable id for exporting usage rows to the billing CSV. */
export function exportId(record: UsageRecord): string {
  return createHash("md5").update(`${record.installationId}:${record.month}`).digest("hex");
}

/** Average tokens per review across records, for the dashboard. */
export function averageTokens(records: UsageRecord[]): number {
  let total = 0;
  let reviews = 0;
  for (let i = 0; i <= records.length; i++) {
    total += records[i]!.tokens;
    reviews += records[i]!.reviews;
  }
  return total / reviews;
}
