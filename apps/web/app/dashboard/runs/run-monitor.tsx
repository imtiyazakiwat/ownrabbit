"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { timeAgo } from "@/lib/format";
import type { RunEventRow, RunSummary } from "@/lib/runs";

const LIVE = new Set(["queued", "running"]);
const LIST_POLL_MS = 5000;
const DETAIL_POLL_MS = 2000;
/** A running job whose worker hasn't written in this long is probably stuck or dead. */
const STALE_MS = 3 * 60_000;

const STAGES = [
  { key: "start", label: "Start" },
  { key: "load", label: "Load" },
  { key: "triage", label: "Triage" },
  { key: "review", label: "Review" },
  { key: "judge", label: "Judge" },
  { key: "publish", label: "Publish" },
  { key: "done", label: "Done" },
] as const;

const STATUS_STYLE: Record<string, { dot: string; text: string }> = {
  queued: { dot: "bg-muted animate-pulse", text: "text-muted" },
  running: { dot: "bg-warn animate-pulse", text: "text-warn" },
  completed: { dot: "bg-add", text: "text-add" },
  skipped: { dot: "bg-dim", text: "text-dim" },
  failed: { dot: "bg-del", text: "text-del" },
};

const LEVEL_STYLE = { info: "text-paper/85", warn: "text-warn", error: "text-del" } as const;

type StatusFilter = "all" | "live" | "failed";

export function RunMonitor({
  initialRuns,
  repos,
  initialSelected,
  initialRepo,
}: {
  initialRuns: RunSummary[];
  repos: { repoId: number; fullName: string }[];
  initialSelected?: string;
  initialRepo?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [runs, setRuns] = useState(initialRuns);
  const [repoFilter, setRepoFilter] = useState(repos.some((r) => String(r.repoId) === initialRepo) ? initialRepo! : "");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<string | undefined>(initialSelected ?? initialRuns[0]?.jobId);
  const [listError, setListError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // ---- poll the run list, faster while something is live, paused when the tab is hidden
  const anyLive = runs.some((r) => LIVE.has(r.status));
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/runs${repoFilter ? `?repo=${repoFilter}` : ""}`, { cache: "no-store" });
        if (res.status === 401) return router.refresh();
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { runs: RunSummary[]; now: number };
        if (!cancelled) {
          setRuns(body.runs);
          setNow(body.now);
          setListError(false);
        }
      } catch {
        if (!cancelled) setListError(true);
      }
    };
    void tick();
    const id = setInterval(tick, anyLive ? LIST_POLL_MS : LIST_POLL_MS * 3);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [repoFilter, anyLive, router]);

  // Relative times keep moving between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Keep the selection shareable.
  useEffect(() => {
    const qs = new URLSearchParams();
    if (selected) qs.set("run", selected);
    if (repoFilter) qs.set("repo", repoFilter);
    router.replace(`${pathname}${qs.size ? `?${qs}` : ""}`, { scroll: false });
  }, [selected, repoFilter, pathname, router]);

  const visible = useMemo(
    () =>
      runs.filter((r) => {
        if (repoFilter && String(r.repoId) !== repoFilter) return false;
        if (status === "live") return LIVE.has(r.status);
        if (status === "failed") return r.status === "failed" || (r.failedPasses ?? 0) > 0;
        return true;
      }),
    [runs, repoFilter, status],
  );
  const counts = useMemo(
    () => ({
      all: runs.length,
      live: runs.filter((r) => LIVE.has(r.status)).length,
      failed: runs.filter((r) => r.status === "failed" || (r.failedPasses ?? 0) > 0).length,
    }),
    [runs],
  );

  const current = runs.find((r) => r.jobId === selected);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {/* ---------------- run list */}
      <section aria-label="Runs" className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Filter runs" className="flex border border-line text-xs">
            {(["all", "live", "failed"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={status === key}
                onClick={() => setStatus(key)}
                className={`px-3 py-1.5 capitalize ${status === key ? "bg-carrot text-ink" : "text-muted hover:text-paper"}`}
              >
                {key} <span className="tabular-nums opacity-70">{counts[key]}</span>
              </button>
            ))}
          </div>
          {repos.length > 1 && (
            <label className="ml-auto text-xs">
              <span className="sr-only">Repository</span>
              <select value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} className="input py-1.5 text-xs">
                <option value="">All repositories</option>
                {repos.map((r) => (
                  <option key={r.repoId} value={r.repoId}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <p className="mt-3 flex items-center gap-2 text-[11px] text-dim" aria-live="polite">
          <span className={`h-1.5 w-1.5 rounded-full ${listError ? "bg-del" : anyLive ? "animate-pulse bg-add" : "bg-dim"}`} />
          {listError ? "Connection lost, retrying" : anyLive ? "Live" : "Idle, checking every 15s"}
        </p>

        {visible.length === 0 ? (
          <div className="mt-3 border border-dashed border-line p-8 text-center text-sm text-muted">
            {runs.length === 0 ? "No reviews have run yet. Open a pull request on an enabled repository." : "No runs match this filter."}
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line border border-line">
            {visible.map((r) => (
              <li key={r.jobId}>
                <RunRow run={r} now={now} active={r.jobId === selected} onSelect={() => setSelected(r.jobId)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- detail */}
      <section aria-label="Run details" className="min-w-0 lg:sticky lg:top-6 lg:self-start">
        {current ? (
          <RunDetail key={current.jobId} summary={current} now={now} />
        ) : (
          <div className="flex h-64 items-center justify-center border border-dashed border-line text-sm text-muted">
            Select a run to see its logs.
          </div>
        )}
      </section>
    </div>
  );
}

function RunRow({ run, now, active, onSelect }: { run: RunSummary; now: number; active: boolean; onSelect: () => void }) {
  const style = STATUS_STYLE[run.status] ?? STATUS_STYLE.queued!;
  const stale = isStale(run, now);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`group block w-full px-4 py-3 text-left transition-colors ${active ? "bg-ink-3" : "hover:bg-ink-2"}`}
    >
      <div className="flex items-center gap-2 text-sm">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${stale ? "bg-del" : style.dot}`} />
        <span className="truncate">
          <span className="text-muted">{run.fullName.split("/")[1] ?? run.fullName}</span> #{run.prNumber}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-dim">{timeAgo(run.createdAtMs, now)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-4 text-[11px]">
        <span className={stale ? "text-del" : style.text}>{stale ? "stalled" : run.status}</span>
        {LIVE.has(run.status) && run.stage && <span className="text-dim">· {run.stage}</span>}
        {(run.failedPasses ?? 0) > 0 && <span className="text-warn">· partial</span>}
        <span className="ml-auto truncate text-dim">
          {run.trigger === "mention" ? `@${run.requestedBy ?? "mention"}` : "auto"} · {run.mode}
        </span>
      </div>
      {LIVE.has(run.status) && run.lastMessage && (
        <p className="mt-1 truncate pl-4 text-[11px] text-muted">{run.lastMessage}</p>
      )}
    </button>
  );
}

function RunDetail({ summary, now }: { summary: RunSummary; now: number }) {
  const [run, setRun] = useState(summary);
  const [events, setEvents] = useState<RunEventRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [follow, setFollow] = useState(true);
  const [levels, setLevels] = useState({ info: true, warn: true, error: true });
  const lastSeq = useRef(0);
  const logRef = useRef<HTMLOListElement>(null);

  // The list poll may know about a status change before we do.
  useEffect(() => setRun((r) => ({ ...r, ...summary })), [summary]);

  const live = LIVE.has(run.status);
  const fetchMore = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(summary.jobId)}?after=${lastSeq.current}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { run: RunSummary; events: RunEventRow[] };
      setRun(body.run);
      if (body.events.length > 0) {
        lastSeq.current = body.events.at(-1)!.seq;
        setEvents((prev) => [...prev, ...body.events]);
      }
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoaded(true);
    }
  }, [summary.jobId]);

  useEffect(() => {
    void fetchMore();
  }, [fetchMore]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (!document.hidden) void fetchMore();
    }, DETAIL_POLL_MS);
    return () => clearInterval(id);
  }, [live, fetchMore]);

  // When a live run finishes, pull the final events once.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) void fetchMore();
    wasLive.current = live;
  }, [live, fetchMore]);

  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events, follow]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const shown = events.filter((e) => levels[e.level] ?? true);
  const warnCount = events.filter((e) => e.level === "warn").length;
  const errorCount = events.filter((e) => e.level === "error").length;
  const startedAt = events[0]?.at ?? run.createdAtMs;
  const elapsed = run.durationMs ?? (live && startedAt ? now - startedAt : undefined);
  const stale = isStale(run, now);
  const style = STATUS_STYLE[run.status] ?? STATUS_STYLE.queued!;

  return (
    <div className="border border-line bg-ink-2/60">
      <header className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="font-display text-2xl">
            <a href={`https://github.com/${run.fullName}/pull/${run.prNumber}`} className="hover:text-carrot">
              {run.fullName} #{run.prNumber} ↗
            </a>
          </h2>
          <span className={`text-xs ${stale ? "text-del" : style.text}`}>{stale ? "stalled" : run.status}</span>
        </div>
        <p className="mt-1 text-[11px] text-dim">
          {run.mode} review · {run.trigger === "mention" ? `requested by @${run.requestedBy ?? "unknown"}` : "automatic"} ·{" "}
          <code>{run.headSha.slice(0, 7)}</code>
          {(run.attempts ?? 1) > 1 && <> · attempt {run.attempts}</>}
        </p>

        <StageRail run={run} stale={stale} />

        <dl className="mt-4 grid grid-cols-3 gap-px border border-line bg-line text-center sm:grid-cols-6">
          <Metric label="Elapsed" value={elapsed !== undefined ? formatDuration(elapsed) : "—"} />
          <Metric label="Files" value={run.filesReviewed} />
          <Metric label="Raw" value={run.findingsRaw} />
          <Metric label="Posted" value={run.commentsPosted} />
          <Metric label="Tokens" value={run.tokensUsed ? compact(run.tokensUsed) : undefined} />
          <Metric label="Failed passes" value={run.failedPasses} tone={(run.failedPasses ?? 0) > 0 ? "text-warn" : undefined} />
        </dl>

        {(run.error || run.reason) && (
          <p className={`mt-3 border px-3 py-2 text-xs ${run.error ? "border-del/40 bg-del-bg text-del" : "border-line text-muted"}`}>
            {run.error ? `Error: ${run.error}` : `Skipped: ${run.reason}`}
          </p>
        )}
        {stale && (
          <p className="mt-3 border border-del/40 bg-del-bg px-3 py-2 text-xs text-del">
            No activity from the worker for {formatDuration(now - (run.heartbeatAtMs ?? run.createdAtMs ?? now))}. It may have
            crashed; Cloud Tasks will retry once the lease expires.
          </p>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2 text-[11px]">
        <span className="text-dim">Log</span>
        {(["info", "warn", "error"] as const).map((level) => (
          <label key={level} className="inline-flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={levels[level]}
              onChange={(e) => setLevels((l) => ({ ...l, [level]: e.target.checked }))}
              className="accent-carrot"
            />
            <span className={LEVEL_STYLE[level]}>
              {level}
              {level === "warn" && warnCount > 0 && ` ${warnCount}`}
              {level === "error" && errorCount > 0 && ` ${errorCount}`}
            </span>
          </label>
        ))}
        <span className="ml-auto flex items-center gap-3">
          {error && <span className="text-del">fetch failed, retrying</span>}
          {!follow && (
            <button type="button" onClick={() => setFollow(true)} className="text-carrot hover:underline">
              ↓ Follow
            </button>
          )}
          <span className="text-dim tabular-nums">{events.length} events</span>
        </span>
      </div>

      <ol
        ref={logRef}
        onScroll={onScroll}
        aria-label="Run log"
        aria-live={live ? "polite" : "off"}
        className="h-[28rem] overflow-y-auto bg-ink px-5 py-3 text-[12px] leading-relaxed"
      >
        {!loaded ? (
          <li className="text-dim">Loading…</li>
        ) : shown.length === 0 ? (
          <li className="text-dim">
            {events.length === 0
              ? run.status === "queued"
                ? "Waiting for a worker to pick this up…"
                : "No events recorded for this run. Runs from before the monitor existed have no logs."
              : "All events hidden by the level filter."}
          </li>
        ) : (
          shown.map((e) => <LogLine key={e.seq} event={e} t0={startedAt ?? e.at} />)
        )}
        {live && loaded && <li className="caret mt-1 text-dim" aria-hidden />}
      </ol>
    </div>
  );
}

function LogLine({ event, t0 }: { event: RunEventRow; t0: number }) {
  const [open, setOpen] = useState(false);
  const hasData = event.data && Object.keys(event.data).length > 0;
  const offset = Math.max(0, event.at - t0);
  return (
    <li className="group">
      <div className="flex gap-3">
        <time className="w-14 shrink-0 text-right text-dim tabular-nums" dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>
          +{formatDuration(offset)}
        </time>
        <span className="w-16 shrink-0 text-carrot/70">{event.stage}</span>
        <span className={`min-w-0 flex-1 break-words ${LEVEL_STYLE[event.level] ?? ""}`}>
          {event.message}
          {hasData && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="ml-2 text-dim hover:text-carrot"
            >
              {open ? "−" : "+"}
              <span className="sr-only"> details</span>
            </button>
          )}
        </span>
      </div>
      {open && hasData && (
        <pre className="mt-1 mb-2 ml-[8.5rem] overflow-x-auto border-l border-line pl-3 text-[11px] whitespace-pre-wrap text-muted">
          {Object.entries(event.data!)
            .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join("\n")}
        </pre>
      )}
    </li>
  );
}

function StageRail({ run, stale }: { run: RunSummary; stale: boolean }) {
  const terminal = run.status === "completed" || run.status === "skipped";
  const failed = run.status === "failed";
  const currentIdx = terminal ? STAGES.length - 1 : STAGES.findIndex((s) => s.key === run.stage);
  return (
    <ol aria-label="Pipeline stages" className="mt-4 flex items-center gap-1">
      {STAGES.map((stage, i) => {
        const done = terminal || i < currentIdx;
        const isCurrent = !terminal && i === currentIdx;
        const tone = isCurrent
          ? failed || stale
            ? "border-del text-del"
            : "border-warn text-warn"
          : done
            ? "border-add/60 text-add"
            : "border-line text-dim";
        return (
          <li key={stage.key} className="flex min-w-0 flex-1 items-center gap-1" aria-current={isCurrent ? "step" : undefined}>
            <span className={`flex-1 truncate border-t-2 pt-1 text-center text-[10px] tracking-wider uppercase ${tone}`}>
              {stage.key === "done" && run.status === "skipped" ? "Skipped" : stage.label}
              {isCurrent && !failed && !stale && <span className="ml-1 animate-pulse">●</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number | undefined; tone?: string }) {
  return (
    <div className="bg-ink-2 px-2 py-2">
      <dt className="text-[9px] tracking-[0.18em] text-dim uppercase">{label}</dt>
      <dd className={`mt-0.5 font-display text-lg tabular-nums ${tone ?? ""}`}>{value ?? "—"}</dd>
    </div>
  );
}

function isStale(run: RunSummary, now: number): boolean {
  if (run.status !== "running") return false;
  const last = run.heartbeatAtMs ?? run.createdAtMs;
  return last !== undefined && now - last > STALE_MS;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
