import { resolveSettings } from "@ownrabbit/core";
import { collections, db, type ReviewDoc } from "@ownrabbit/core/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findAccessibleRepo, loadRepoDocs } from "@/lib/access";
import { getSession } from "@/lib/session";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  completed: "text-add",
  running: "text-warn",
  queued: "text-muted",
  skipped: "text-dim",
  failed: "text-del",
};

async function recentReviews(repoId: number): Promise<(ReviewDoc & { createdAtMs?: number })[]> {
  const snap = await db()
    .collection(collections.reviews)
    .where("repoId", "==", repoId)
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  return snap.docs.map((d) => {
    const data = d.data() as ReviewDoc & { createdAt?: { toMillis(): number } };
    return { ...data, createdAt: undefined, updatedAt: undefined, createdAtMs: data.createdAt?.toMillis() };
  });
}

export default async function RepoPage({ params }: { params: Promise<{ repoId: string }> }) {
  const { repoId: raw } = await params;
  const session = (await getSession())!;
  const repo = await findAccessibleRepo(session, Number(raw));
  if (!repo) notFound();

  const [docs, reviews] = await Promise.all([
    loadRepoDocs([repo.repoId]),
    recentReviews(repo.repoId).catch(() => null),
  ]);
  const settings = resolveSettings(docs.get(repo.repoId)?.settings);

  return (
    <main className="pt-10">
      <Link href="/dashboard" className="text-xs text-muted hover:text-carrot">
        ← all repositories
      </Link>
      <h1 className="mt-3 font-display text-4xl break-all">{repo.fullName}</h1>
      {!repo.canEdit && (
        <p className="mt-4 border border-warn/40 px-4 py-2 text-sm text-warn">
          Read-only: you need admin or maintain access on this repository to change its settings.
        </p>
      )}

      <div className="mt-10 grid gap-12 lg:grid-cols-[1.4fr_1fr]">
        <SettingsForm repoId={repo.repoId} initial={settings} canEdit={repo.canEdit} />

        <section aria-labelledby="recent">
          <h2 id="recent" className="font-display text-2xl">
            Recent reviews
          </h2>
          {reviews === null ? (
            <p className="mt-4 text-sm text-del">Couldn’t load review history.</p>
          ) : reviews.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No reviews yet. Open a pull request to get the first one.</p>
          ) : (
            <table className="mt-4 w-full text-left text-xs">
              <thead className="text-dim">
                <tr className="border-b border-line">
                  <th scope="col" className="py-2 font-normal">PR</th>
                  <th scope="col" className="py-2 font-normal">Status</th>
                  <th scope="col" className="py-2 font-normal">Comments</th>
                  <th scope="col" className="py-2 text-right font-normal">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {reviews.map((r) => (
                  <tr key={r.jobId}>
                    <td className="py-2">
                      <a
                        href={`https://github.com/${repo.fullName}/pull/${r.prNumber}`}
                        className="hover:text-carrot"
                      >
                        #{r.prNumber}
                      </a>{" "}
                      <span className="text-dim">{r.mode === "full" ? "full" : "incr"}</span>
                    </td>
                    <td className={`py-2 ${STATUS_TONE[r.status] ?? ""}`} title={r.error ?? r.reason ?? ""}>
                      {r.status}
                    </td>
                    <td className="py-2">{r.commentsPosted ?? "—"}</td>
                    <td className="py-2 text-right text-dim">
                      {r.createdAtMs ? new Date(r.createdAtMs).toISOString().slice(0, 16).replace("T", " ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}
