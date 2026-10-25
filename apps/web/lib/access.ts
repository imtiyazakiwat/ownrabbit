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
      });
    }
  }
  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function findAccessibleRepo(session: Session, repoId: number): Promise<AccessibleRepo | undefined> {
  if (!Number.isSafeInteger(repoId) || repoId <= 0) return undefined;
  return (await listAccessibleRepos(session)).find((r) => r.repoId === repoId);
}

export async function loadRepoDocs(repoIds: number[]): Promise<Map<number, RepoDoc>> {
  const out = new Map<number, RepoDoc>();
  if (repoIds.length === 0) return out;
  const refs = repoIds.map((id) => db().collection(collections.repos).doc(String(id)));
  const snaps = await db().getAll(...refs);
  for (const snap of snaps) if (snap.exists) out.set(Number(snap.id), snap.data() as RepoDoc);
  return out;
}
