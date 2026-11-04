"use server";

import { z } from "zod";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { FREE_MODEL_IDS } from "@ownrabbit/core";
import {
  collections,
  db,
  FieldValue,
  getPauseState,
  REVIEW_MODEL_DOC_PATH,
  SERVICE_PAUSE_DOC_PATH,
  type PauseState,
} from "@ownrabbit/core/server";
import { isAdmin } from "@/lib/admin";
import { sweepPausedComments } from "@/lib/pause-sweep";
import { getSession } from "@/lib/session";

export type PauseResult =
  | { ok: true; state: PauseState }
  | { ok: false; error: string };

const PauseInput = z
  .object({
    paused: z.boolean(),
    message: z.string().max(1000),
  })
  .strict();

const ReviewModelInput = z
  .object({
    defaultModel: z.enum(FREE_MODEL_IDS),
  })
  .strict();

export type ReviewModelResult =
  | { ok: true; defaultModel: string }
  | { ok: false; error: string };

/** Admin-only platform default for repositories without a free-model override. */
export async function setReviewModel(input: unknown): Promise<ReviewModelResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (!isAdmin(session)) return { ok: false, error: "Only admins can change the default model." };

  const parsed = ReviewModelInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a free model from the list." };

  await db()
    .collection(REVIEW_MODEL_DOC_PATH.collection)
    .doc(REVIEW_MODEL_DOC_PATH.id)
    .set(
      {
        defaultModel: parsed.data.defaultModel,
        updatedBy: session.login,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  revalidatePath("/dashboard/service");
  revalidatePath("/dashboard/admin");
  revalidatePath("/dashboard");
  return { ok: true, defaultModel: parsed.data.defaultModel };
}

/**
 * Pause or resume the service. Turning the pause on schedules a background
 * sweep that posts the note on every open PR of every active installation.
 */
export async function setServicePause(input: unknown): Promise<PauseResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (!isAdmin(session)) return { ok: false, error: "Only admins can change the service state." };

  const parsed = PauseInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: `message: ${parsed.error.issues[0]?.message ?? "invalid settings"}` };
  const { paused, message } = parsed.data;

  const doc = db().collection(collections.config).doc(SERVICE_PAUSE_DOC_PATH.id);
  await doc.set(
    {
      paused,
      message: message.trim(),
      ...(paused ? { pausedBy: session.login, pausedAt: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  if (!paused) {
    // Resume: clear the pause bookkeeping so a previous cycle's sweep stats
    // can't be mistaken for the next one's.
    await doc
      .update({ pausedBy: FieldValue.delete(), pausedAt: FieldValue.delete(), sweep: FieldValue.delete() })
      .catch(() => undefined);
  }

  const state = await getPauseState();

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/runs");
  revalidatePath("/dashboard/service");
  revalidatePath("/dashboard/admin");

  if (paused) {
    after(async () => {
      try {
        await sweepPausedComments();
        revalidatePath("/dashboard/service");
        revalidatePath("/dashboard/admin");
      } catch (err) {
        console.error("pause sweep failed", err);
      }
    });
  }

  return { ok: true, state };
}
