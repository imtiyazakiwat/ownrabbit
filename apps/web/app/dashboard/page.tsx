import { DEPTH_PROFILES, resolveSettings } from "@ownrabbit/core";
import Link from "next/link";
import { GitHubMark } from "@/components/brand";
import { listAccessibleRepos, loadRepoDocs } from "@/lib/access";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const TRIGGER_LABEL = { auto: "auto", mention: "@mention", both: "auto + @mention" } as const;

export default async function Dashboard() {
  const session = (await getSession())!;
  const appSlug = process.env.GITHUB_APP_SLUG ?? "ownrabbit";
  const repos = await listAccessibleRepos(session).catch(() => null);
  const docs = repos ? await loadRepoDocs(repos.map((r) => r.repoId)) : new Map();

  return (
    <main className="pt-12">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-carrot">Repositories</p>
          <h1 className="mt-2 font-display text-4xl">Where the rabbit reads</h1>
        </div>
        <a
          href={`https://github.com/apps/${appSlug}/installations/new`}
          className="inline-flex items-center gap-2 border border-line px-4 py-2 text-sm hover:border-paper"
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
        <ul className="mt-10 divide-y divide-line border-y border-line">
          {repos.map((repo, i) => {
            const doc = docs.get(repo.repoId);
            const settings = resolveSettings(doc?.settings);
            const enabled = settings.enabled && doc?.active !== false;
            return (
              <li key={repo.repoId} className="rise" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                <Link
                  href={`/dashboard/${repo.repoId}`}
                  className="group grid items-center gap-2 py-4 md:grid-cols-[1fr_auto_auto_auto] md:gap-8"
                >
                  <span className="flex items-center gap-3">
                    <span
                      aria-label={enabled ? "enabled" : "disabled"}
                      className={`h-2 w-2 rounded-full ${enabled ? "bg-add" : "bg-dim"}`}
                    />
                    <span className="font-display text-lg group-hover:text-carrot">{repo.fullName}</span>
                    {repo.private && <span className="border border-line px-1.5 text-[10px] text-muted">private</span>}
                  </span>
                  <span className="text-xs text-muted">{TRIGGER_LABEL[settings.trigger]}</span>
                  <span className="text-xs text-muted">
                    {DEPTH_PROFILES[settings.depth].label} · {settings.reviewers.length} reviewers
                  </span>
                  <span className="text-xs text-dim group-hover:text-carrot">{repo.canEdit ? "configure →" : "view →"}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
