import { resolveSettings } from "@ownrabbit/core";
import { collections, db, type ReviewDoc } from "@ownrabbit/core/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findAccessibleRepo, loadRepoDocs } from "@/lib/access";
import { LANGUAGE_COLORS, timeAgo } from "@/lib/format";
import { getSession } from "@/lib/session";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Repository settings" };

const STATUS_TONE: Record<string, string> = {
  completed: "text-add",
  running: "text-warn",
  queued: "text-muted",
  skipped: "text-dim",
  failed: "text-del",
};

type ReviewRow = ReviewDoc & { createdAtMs?: number; tokensUsed?: number };

async function recentReviews(repoId: number): Promise<ReviewRow[]> {
  const snap = await db()
    .collection(collections.reviews)
    .where("repoId", "==", repoId)
    .orderBy("createdAt", "desc")
    .limit(25)
    .get();
  return snap.docs.map((d) => {
    const data = d.data() as ReviewDoc & { createdAt?: { toMillis(): number }; tokensUsed?: number };
    // Firestore Timestamps aren't serializable; flatten to millis.
    return { ...data, createdAt: undefined, updatedAt: undefined, createdAtMs: data.createdAt?.toMillis() };
  });
}

export default async function RepoPage({ params }: { params: Promise<{ repoId: string }> }) {
  const { repoId: raw } = await params;
  const session = (await getSession())!;
  const repo = await findAccessibleRepo(session, Number(raw)).catch(() => undefined);
  if (!repo) notFound();

  const [docs, reviews] = await Promise.all([loadRepoDocs([repo.repoId]), recentReviews(repo.repoId).catch(() => null)]);
  const settings = resolveSettings(docs.get(repo.repoId)?.settings);
  const mention = `@${process.env.GITHUB_APP_SLUG ?? "ownrabbit"}`;

  const done = reviews?.filter((r) => r.status === "completed") ?? [];
  const totalComments = done.reduce((sum, r) => sum + (r.commentsPosted ?? 0), 0);
  const avgSeconds = done.length ? Math.round(done.reduce((s, r) => s + (r.durationMs ?? 0), 0) / done.length / 1000) : null;
  const failed = reviews?.filter((r) => r.status === "failed").length ?? 0;

  return (
    <main className="pt-8">
      <nav aria-label="Breadcrumb" className="text-xs text-muted">
        <Link href="/dashboard" className="hover:text-carrot">
          Repositories
        </Link>
        <span className="mx-2 text-dim">/</span>
        <span className="text-paper">{repo.name}</span>
      </nav>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-6 border-b border-line pb-8">
        <div className="flex min-w-0 gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={repo.ownerAvatar} alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded-lg border border-line" />
          <div className="min-w-0">
            <h1 className="font-display text-3xl break-all md:text-4xl">
              <span className="text-muted">{repo.owner}/</span>
              {repo.name}
            </h1>
            {repo.description && <p className="mt-1 max-w-2xl text-sm text-muted">{repo.description}</p>}
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-dim">
              {repo.language && (
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: LANGUAGE_COLORS[repo.language] ?? "var(--color-muted)" }} />
                  {repo.language}
                </span>
              )}
              <span>{repo.private ? "Private" : "Public"}</span>
              <span>Pushed {timeAgo(repo.pushedAt)}</span>
              <a href={`https://github.com/${repo.fullName}`} className="hover:text-carrot">
                View on GitHub ↗
              </a>
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-3 border border-line text-center">
          <Stat label="Reviews" value={reviews ? String(reviews.length) : "—"} />
          <Stat label="Comments" value={reviews ? String(totalComments) : "—"} />
          <Stat label="Avg time" value={avgSeconds !== null ? `${avgSeconds}s` : "—"} warn={failed > 0 ? `${failed} failed` : undefined} />
        </dl>
      </header>

      {!repo.canEdit && (
        <p className="mt-6 border border-warn/40 bg-warn/5 px-4 py-3 text-sm text-warn">
          Read-only. You need admin or maintain access on this repository to change its settings.
        </p>
      )}

      <div className="mt-10">
        <SettingsForm repoId={repo.repoId} initial={settings} canEdit={repo.canEdit} mention={mention} />
      </div>

      <section aria-labelledby="history" className="mt-20">
        <div className="flex items-baseline justify-between border-b border-line pb-3">
          <h2 id="history" className="font-display text-2xl">
            Review history
          </h2>
          <span className="flex gap-4 text-xs text-dim">
            last 25
            <Link href={`/dashboard/runs?repo=${repo.repoId}`} className="text-carrot hover:underline">
              Open monitor →
            </Link>
          </span>
        </div>
        {reviews === null ? (
          <p className="mt-4 text-sm text-del">Couldn’t load review history.</p>
        ) : reviews.length === 0 ? (
          <div className="mt-4 border border-dashed border-line p-8 text-center text-sm text-muted">
            No reviews yet. Open a pull request{settings.trigger === "mention" ? `, then comment ${mention}` : ""} to get the first one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="mt-2 w-full min-w-[640px] text-left text-xs">
              <thead className="text-dim">
                <tr className="border-b border-line">
                  <th scope="col" className="py-2 font-normal">Pull request</th>
                  <th scope="col" className="py-2 font-normal">Trigger</th>
                  <th scope="col" className="py-2 font-normal">Status</th>
                  <th scope="col" className="py-2 text-right font-normal">Files</th>
                  <th scope="col" className="py-2 text-right font-normal">Comments</th>
                  <th scope="col" className="py-2 text-right font-normal">Duration</th>
                  <th scope="col" className="py-2 text-right font-normal">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {reviews.map((r) => (
                  <tr key={r.jobId} className="hover:bg-ink-2">
                    <td className="py-2.5">
                      <a href={`https://github.com/${repo.fullName}/pull/${r.prNumber}`} className="hover:text-carrot">
                        #{r.prNumber}
                      </a>
                      <span className="ml-2 text-dim">
                        {r.mode} · <code>{r.headSha.slice(0, 7)}</code>
                      </span>
                    </td>
                    <td className="py-2.5 text-muted">{r.trigger === "mention" ? "mention" : "auto"}</td>
                    <td className={`py-2.5 ${STATUS_TONE[r.status] ?? ""}`}>
                      <Link href={`/dashboard/runs?run=${encodeURIComponent(r.jobId)}&repo=${repo.repoId}`} className="hover:underline">
                        {r.status}
                      </Link>
                      {(r.error || r.reason) && <span className="ml-2 text-dim">{(r.error ?? r.reason)!.slice(0, 40)}</span>}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{r.filesReviewed ?? "—"}</td>
                    <td className="py-2.5 text-right tabular-nums">{r.commentsPosted ?? "—"}</td>
                    <td className="py-2.5 text-right tabular-nums text-muted">{r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : "—"}</td>
                    <td className="py-2.5 text-right text-dim" title={r.createdAtMs ? new Date(r.createdAtMs).toISOString() : undefined}>
                      {timeAgo(r.createdAtMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: string }) {
  return (
    <div className="border-r border-line px-5 py-3 last:border-r-0">
      <dt className="text-[10px] tracking-[0.2em] text-dim uppercase">{label}</dt>
      <dd className="mt-1 font-display text-2xl tabular-nums">{value}</dd>
      {warn && <dd className="text-[10px] text-del">{warn}</dd>}
    </div>
  );
}
