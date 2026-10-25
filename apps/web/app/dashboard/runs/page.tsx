import type { Metadata } from "next";
import { listAccessibleRepos } from "@/lib/access";
import { loadRuns } from "@/lib/runs";
import { getSession } from "@/lib/session";
import { RunMonitor } from "./run-monitor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Runs" };

export default async function RunsPage({ searchParams }: { searchParams: Promise<{ run?: string; repo?: string }> }) {
  const session = (await getSession())!;
  const { run, repo } = await searchParams;
  const repos = await listAccessibleRepos(session).catch(() => []);
  const runs = await loadRuns(
    repos.map((r) => r.repoId),
    50,
  ).catch((err) => {
    console.error("loadRuns failed", err);
    return [];
  });

  return (
    <main className="pt-10">
      <p className="text-xs tracking-[0.3em] text-carrot uppercase">Monitor</p>
      <h1 className="mt-2 font-display text-4xl">Review runs</h1>
      <p className="mt-2 text-sm text-muted">Live status and logs for every review across your repositories.</p>
      <div className="mt-8">
        <RunMonitor
          initialRuns={runs}
          repos={repos.map((r) => ({ repoId: r.repoId, fullName: r.fullName }))}
          initialSelected={run}
          initialRepo={repo}
        />
      </div>
    </main>
  );
}
