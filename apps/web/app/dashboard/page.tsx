import { resolveSettings } from "@ownrabbit/core";
import { Suspense } from "react";
import { GitHubMark } from "@/components/brand";
import { listAccessibleRepos, loadLastReviews, loadRepoDocs } from "@/lib/access";
import { getSession } from "@/lib/session";
import { RepoList, type RepoRow } from "./repo-list";

export const dynamic = "force-dynamic";

export const metadata = { title: "Repositories" };

export default async function Dashboard() {
  const session = (await getSession())!;
  const appSlug = process.env.GITHUB_APP_SLUG ?? "ownrabbit";
  const repos = await listAccessibleRepos(session).catch((err) => {
    console.error("listAccessibleRepos failed", err);
    return null;
  });

  const ids = repos?.map((r) => r.repoId) ?? [];
  const [docs, lastReviews] = await Promise.all([loadRepoDocs(ids), loadLastReviews(ids)]);

  const rows: RepoRow[] = (repos ?? []).map((repo) => {
    const doc = docs.get(repo.repoId);
    const settings = resolveSettings(doc?.settings);
    return {
      repoId: repo.repoId,
      fullName: repo.fullName,
      owner: repo.owner,
      name: repo.name,
      ownerAvatar: repo.ownerAvatar,
      private: repo.private,
      canEdit: repo.canEdit,
      description: repo.description,
      language: repo.language,
      pushedAt: repo.pushedAt,
      enabled: settings.enabled && doc?.active !== false,
      trigger: settings.trigger,
      depth: settings.depth,
      reviewerCount: settings.reviewers.length,
      lastReview: lastReviews.get(repo.repoId) ?? null,
    };
  });

  const enabled = rows.filter((r) => r.enabled).length;
  const reviewed = rows.filter((r) => r.lastReview).length;

  return (
    <main className="pt-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-xs tracking-[0.3em] text-carrot uppercase">Repositories</p>
          <h1 className="mt-2 font-display text-4xl">Where the rabbit reads</h1>
          {repos && repos.length > 0 && (
            <p className="mt-2 text-sm text-muted">
              {enabled} of {rows.length} enabled · {reviewed} reviewed at least once
            </p>
          )}
        </div>
        <a
          href={`https://github.com/apps/${appSlug}/installations/new`}
          className="inline-flex items-center gap-2 bg-carrot px-4 py-2 text-sm font-semibold text-ink transition hover:bg-paper"
        >
          <GitHubMark /> Add repositories
        </a>
      </div>

      {repos === null ? (
        <p role="alert" className="mt-10 border border-del/40 bg-del-bg p-4 text-del">
          Couldn’t load your repositories from GitHub. Your session may have expired.{" "}
          <a href="/api/auth/login" className="underline">
            Sign in again
          </a>
          .
        </p>
      ) : repos.length === 0 ? (
        <div className="mt-12 border border-dashed border-line p-12 text-center">
          <p className="font-display text-2xl">No repositories yet.</p>
          <p className="mt-2 text-muted">Install the GitHub App on a repository and it will show up here.</p>
        </div>
      ) : (
        // useSearchParams requires a Suspense boundary.
        <Suspense>
          <RepoList repos={rows} />
        </Suspense>
      )}
    </main>
  );
}
