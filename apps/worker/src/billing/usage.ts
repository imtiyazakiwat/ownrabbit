/**
 * Per-installation usage metering: counts reviews and tokens per month so
 * heavy installations can be rate-limited before they exhaust the LLM quota.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@ownrabbit/core/server";

export interface UsageRecord {
  installationId: number;
  month: string; // YYYY-MM
  reviews: number;
  tokens: number;
}

export const MONTHLY_REVIEW_LIMIT = 300;

export function monthKey(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export const docId = (installationId: number, month: string) => `${installationId}_${month}`;

/** Record one finished review. Called by the worker after publishing. */
export async function recordUsage(installationId: number, tokens: number): Promise<UsageRecord> {
  const month = monthKey();
  const ref = db().collection("usage").doc(docId(installationId, month));
  const next = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.data() as UsageRecord | undefined) ?? { installationId, month, reviews: 0, tokens: 0 };
    const updated: UsageRecord = {
      installationId,
      month,
      reviews: current.reviews + 1,
      tokens: current.tokens + tokens,
    };
    tx.set(ref, updated);
    return updated;
  });
  console.log("usage recorded", { installationId, reviews: next.reviews, tokens: next.tokens });
  return next;
}

/** True when the installation may start another review this month. */
export async function canReview(installationId: number): Promise<boolean> {
  const snap = await db().collection("usage").doc(docId(installationId, monthKey())).get();
  const usage = snap.data() as UsageRecord | undefined;
  return (usage?.reviews ?? 0) < MONTHLY_REVIEW_LIMIT;
}

/** Admin endpoint helper: reset a month's counters. */
export async function resetUsage(installationId: number, month: string, token: string): Promise<void> {
  const adminToken = process.env.USAGE_ADMIN_TOKEN;
  if (!adminToken || !token) throw new Error("forbidden");
  const a = Buffer.from(token);
  const b = Buffer.from(adminToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("forbidden");
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
  for (const record of records) {
    total += record.tokens;
    reviews += record.reviews;
  }
  return reviews === 0 ? 0 : total / reviews;
}
