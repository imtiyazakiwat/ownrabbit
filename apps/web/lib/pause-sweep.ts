import "server-only";
import {
  collections,
  db,
  FieldValue,
  getPauseState,
  installationOctokit,
  mentionHandle,
  postPausedComment,
} from "@ownrabbit/core/server";

/**
 * Post (or update) the pause note on every open PR across all active
 * installations. Runs in the background while the service is paused; the
 * result is stored on the pause document for the dashboard to display.
 */
export async function sweepPausedComments(): Promise<void> {
  const pause = await getPauseState();
  if (!pause.paused) return;

  const repos = await db().collection(collections.repos).get();
  const active = repos.docs.filter((snap) => snap.data().active !== false);
  const mention = mentionHandle();

  let total = 0;
  let notified = 0;
  let failed = 0;

  for (const snap of active) {
    const repo = snap.data();
    if (typeof repo.owner !== "string" || typeof repo.name !== "string") continue;
    const repoId = Number(repo.repoId);
    const installationId = Number(repo.installationId);
    if (!Number.isSafeInteger(repoId) || repoId <= 0 || !Number.isSafeInteger(installationId)) continue;

    let octokit;
    try {
      octokit = await installationOctokit(installationId);
    } catch (err) {
      console.error("pause sweep: installation login failed", { repoId, error: (err as Error).message });
      continue;
    }

    const pulls = await octokit.paginate(octokit.rest.pulls.list, {
      owner: repo.owner,
      repo: repo.name,
      state: "open",
      per_page: 100,
    });

    for (const pr of pulls) {
      total++;
      const outcome = await postPausedComment({
        octokit,
        owner: repo.owner,
        repo: repo.name,
        repoId,
        prNumber: pr.number,
        mention,
        message: pause.message,
      });
      if (outcome === "failed") {
        failed++;
        console.error("pause sweep: comment failed", { repoId, prNumber: pr.number });
      } else {
        notified++;
      }
    }
  }

  await db()
    .collection(collections.config)
    .doc("service")
    .set({ sweep: { at: FieldValue.serverTimestamp(), total, notified, failed } }, { merge: true });
  console.log("pause sweep done", { total, notified, failed });
}
