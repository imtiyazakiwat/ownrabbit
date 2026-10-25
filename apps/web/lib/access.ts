import "server-only";
import { Octokit } from "octokit";
import { collections, db, type RepoDoc } from "@ownrabbit/core/server";
import type { Session } from "./session";

export interface AccessibleRepo {
  repoId: number;
  installationId: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  /** Admin/maintain users can change settings; others get read-only. */
  canEdit: boolean;
  description: string | null;
  language: string | null;
  pushedAt: string | null;
  ownerAvatar: string;
}

export interface LastReview {
  prNumber: number;
  status: string;
  commentsPosted?: number;
  createdAtMs?: number;
}

/**
 * Repos this user can see through installations of our App. This is the
 * authorization source of truth: GitHub decides, not our database.
 */
export async function listAccessibleRepos(session: Session): Promise<AccessibleRepo[]> {
  const octokit = new Octokit({ auth: session.token });
  const installations = await octokit.paginate(octokit.rest.apps.listInstallationsForAuthenticatedUser, {
    per_page: 100,
  });

  const repos: AccessibleRepo[] = [];
  for (const installation of installations) {
    const list = await octokit.paginate(octokit.rest.apps.listInstallationReposForAuthenticatedUser, {
      installation_id: installation.id,
      per_page: 100,
    });
    for (const repo of list) {
      const perms = repo.permissions;
      repos.push({
        repoId: repo.id,
        installationId: installation.id,
        fullName: repo.full_name,
        owner: repo.owner.login,
        name: repo.name,
        private: repo.private,
        canEdit: Boolean(perms?.admin || perms?.maintain),
        description: repo.description ?? null,
        language: repo.language ?? null,
        pushedAt: repo.pushed_at ?? null,
        ownerAvatar: repo.owner.avatar_url,
      });
    }
  }
  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

const ACCESS_TTL_MS = 60_000;
const ACCESS_CACHE_MAX = 500;
const accessCache = new Map<string, { at: number; repos: Promise<AccessibleRepo[]> }>();

/**
 * Same as listAccessibleRepos, memoized per user token for a minute. Used by
 * polling endpoints so the run monitor doesn't burn the user's GitHub rate limit.
 * Keyed by token so a new login (or revoked token) never reuses stale access.
 */
export function listAccessibleReposCached(session: Session): Promise<AccessibleRepo[]> {
  const now = Date.now();
  const hit = accessCache.get(session.token);
  if (hit && now - hit.at < ACCESS_TTL_MS) return hit.repos;

  const repos = listAccessibleRepos(session);
  // Don't cache failures.
  repos.catch(() => accessCache.delete(session.token));
  if (accessCache.size >= ACCESS_CACHE_MAX) {
    for (const [key, entry] of accessCache) if (now - entry.at >= ACCESS_TTL_MS) accessCache.delete(key);
    if (accessCache.size >= ACCESS_CACHE_MAX) accessCache.clear();
  }
  accessCache.set(session.token, { at: now, repos });
  return repos;
}

export async function findAccessibleRepo(session: Session, repoId: number): Promise<AccessibleRepo | undefined> {
  if (!Number.isSafeInteger(repoId) || repoId <= 0) return undefined;
  return (await listAccessibleRepos(session)).find((r) => r.repoId === repoId);
}

/** Most recent review per repo. One indexed query per repo, run in parallel. */
export async function loadLastReviews(repoIds: number[]): Promise<Map<number, LastReview>> {
  const out = new Map<number, LastReview>();
  const results = await Promise.allSettled(
    repoIds.map(async (repoId) => {
      const snap = await db()
        .collection(collections.reviews)
        .where("repoId", "==", repoId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();
      const data = snap.docs[0]?.data();
      if (!data) return;
      out.set(repoId, {
        prNumber: data.prNumber,
        status: data.status,
        commentsPosted: data.commentsPosted,
        createdAtMs: data.createdAt?.toMillis?.(),
      });
    }),
  );
  // A rejected lookup just means "no last review" for that repo.
  for (const r of results) if (r.status === "rejected") console.error("last review lookup failed", r.reason);
  return out;
}

export async function loadRepoDocs(repoIds: number[]): Promise<Map<number, RepoDoc>> {
  const out = new Map<number, RepoDoc>();
  if (repoIds.length === 0) return out;
  const refs = repoIds.map((id) => db().collection(collections.repos).doc(String(id)));
  const snaps = await db().getAll(...refs);
  for (const snap of snaps) if (snap.exists) out.set(Number(snap.id), snap.data() as RepoDoc);
  return out;
}
