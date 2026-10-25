"use server";

import { RepoSettingsSchema, type RepoSettings } from "@ownrabbit/core";
import { collections, db, FieldValue } from "@ownrabbit/core/server";
import { revalidatePath } from "next/cache";
import { findAccessibleRepo } from "@/lib/access";
import { getSession } from "@/lib/session";

export type SaveResult = { ok: true; settings: RepoSettings } | { ok: false; error: string };

/**
 * Persist repo settings. Authorization is re-checked against GitHub on every
 * save: the user must have admin or maintain on the repo via our App.
 */
export async function saveRepoSettings(repoId: number, input: unknown): Promise<SaveResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your session expired. Sign in again." };

  const repo = await findAccessibleRepo(session, repoId).catch(() => undefined);
  if (!repo) return { ok: false, error: "Repository not found or not accessible." };
  if (!repo.canEdit) return { ok: false, error: "You need admin or maintain access to change settings." };

  const parsed = RepoSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join(".") || "settings"}: ${issue.message}` : "Invalid settings" };
  }

  await db()
    .collection(collections.repos)
    .doc(String(repo.repoId))
    .set(
      {
        repoId: repo.repoId,
        installationId: repo.installationId,
        fullName: repo.fullName,
        owner: repo.owner,
        name: repo.name,
        private: repo.private,
        active: true,
        settings: parsed.data,
        settingsUpdatedBy: session.login,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  revalidatePath(`/dashboard/${repo.repoId}`);
  return { ok: true, settings: parsed.data };
}
