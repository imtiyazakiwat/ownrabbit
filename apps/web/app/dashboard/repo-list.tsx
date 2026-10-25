"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { LANGUAGE_COLORS, timeAgo } from "@/lib/format";

export interface RepoRow {
  repoId: number;
  fullName: string;
  owner: string;
  name: string;
  ownerAvatar: string;
  private: boolean;
  canEdit: boolean;
  description: string | null;
  language: string | null;
  pushedAt: string | null;
  enabled: boolean;
  trigger: "auto" | "mention" | "both";
  depth: string;
  reviewerCount: number;
  lastReview: { prNumber: number; status: string; commentsPosted?: number; createdAtMs?: number } | null;
}

const STATUS_FILTERS = ["all", "on", "off"] as const;
const SORT_KEYS = ["activity", "name", "reviewed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
type SortKey = (typeof SORT_KEYS)[number];

/** URL params are user-editable, so only accept known values. */
function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;
}

const TRIGGER_SHORT = { auto: "Auto", mention: "Mention", both: "Auto + mention" } as const;
const STATUS_DOT: Record<string, string> = {
  completed: "bg-add",
  running: "bg-warn animate-pulse",
  queued: "bg-muted animate-pulse",
  skipped: "bg-dim",
  failed: "bg-del",
};

export function RepoList({ repos }: { repos: RepoRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [query, setQuery] = useState(params.get("q") ?? "");
  const [status, setStatus] = useState<StatusFilter>(() => pick(params.get("status"), STATUS_FILTERS, "all"));
  const [owner, setOwner] = useState(params.get("owner") ?? "");
  const [sort, setSort] = useState<SortKey>(() => pick(params.get("sort"), SORT_KEYS, "activity"));
  const [active, setActive] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const owners = useMemo(() => [...new Set(repos.map((r) => r.owner))].sort(), [repos]);
  const counts = useMemo(
    () => ({ all: repos.length, on: repos.filter((r) => r.enabled).length, off: repos.filter((r) => !r.enabled).length }),
    [repos],
  );

  const visible = useMemo(() => {
    const terms = deferredQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = repos.filter((r) => {
      if (status === "on" && !r.enabled) return false;
      if (status === "off" && r.enabled) return false;
      if (owner && r.owner !== owner) return false;
      if (terms.length === 0) return true;
      const haystack = `${r.fullName} ${r.description ?? ""} ${r.language ?? ""}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
    const byTime = (v: string | number | null | undefined) => (v ? new Date(v).getTime() : 0);
    return filtered.sort((a, b) => {
      if (sort === "name") return a.fullName.localeCompare(b.fullName);
      if (sort === "reviewed") return byTime(b.lastReview?.createdAtMs) - byTime(a.lastReview?.createdAtMs);
      return byTime(b.pushedAt) - byTime(a.pushedAt);
    });
  }, [repos, deferredQuery, status, owner, sort]);

  // Keep filters in the URL so views are shareable and survive refresh.
  useEffect(() => {
    const next = new URLSearchParams();
    if (deferredQuery) next.set("q", deferredQuery);
    if (status !== "all") next.set("status", status);
    if (owner) next.set("owner", owner);
    if (sort !== "activity") next.set("sort", sort);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [deferredQuery, status, owner, sort, pathname, router]);

  useEffect(() => setActive(0), [deferredQuery, status, owner, sort]);

  // "/" focuses search; arrows move; Enter opens. Ignored while typing elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(visible.length - 1, i + delta)));
    } else if (e.key === "Enter" && visible[active]) {
      router.push(`/dashboard/${visible[active].repoId}`);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const clear = () => {
    setQuery("");
    setStatus("all");
    setOwner("");
  };
  const filtered = query !== "" || status !== "all" || owner !== "";

  return (
    <div className="mt-8">
      <div className="flex flex-col gap-3 border border-line bg-ink-2 p-3 md:flex-row md:items-center">
        <label className="relative flex flex-1 items-center">
          <span className="sr-only">Search repositories</span>
          <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute left-3 h-4 w-4 text-dim" fill="currentColor">
            <path d="M10.68 11.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04ZM11.5 7a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0Z" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search by name, description, or language"
            aria-controls="repo-results"
            aria-activedescendant={visible[active] ? `repo-${visible[active].repoId}` : undefined}
            className="w-full border border-transparent bg-ink py-2 pr-10 pl-9 placeholder:text-dim focus:border-carrot focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-2 border border-line px-1.5 text-[10px] text-dim">/</kbd>
        </label>

        <div role="radiogroup" aria-label="Filter by status" className="flex border border-line">
          {(["all", "on", "off"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={status === key}
              onClick={() => setStatus(key)}
              className={`px-3 py-2 text-xs transition ${
                status === key ? "bg-paper text-ink" : "text-muted hover:text-paper"
              }`}
            >
              {key === "all" ? "All" : key === "on" ? "Enabled" : "Paused"}
              <span className={`ml-1.5 ${status === key ? "text-ink/60" : "text-dim"}`}>{counts[key]}</span>
            </button>
          ))}
        </div>

        {owners.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="sr-only">Owner</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value)} className="input py-2 text-xs md:w-40">
              <option value="">All owners</option>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex items-center gap-2 text-xs text-muted">
          <span className="shrink-0">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="input py-2 text-xs md:w-40">
            <option value="activity">Recently pushed</option>
            <option value="reviewed">Recently reviewed</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <p className="mt-4 flex items-center justify-between text-xs text-dim" aria-live="polite">
        <span>
          {visible.length} of {repos.length} {repos.length === 1 ? "repository" : "repositories"}
        </span>
        {filtered && (
          <button type="button" onClick={clear} className="hover:text-carrot">
            Clear filters
          </button>
        )}
      </p>

      {visible.length === 0 ? (
        <div className="mt-3 border border-dashed border-line px-6 py-16 text-center">
          <p className="font-display text-xl">No repositories match.</p>
          <p className="mt-1 text-sm text-muted">Try a different search, or clear your filters.</p>
          <button type="button" onClick={clear} className="mt-4 border border-line px-4 py-1.5 text-sm hover:border-carrot">
            Clear filters
          </button>
        </div>
      ) : (
        <ul ref={listRef} id="repo-results" role="listbox" aria-label="Repositories" className="mt-3 border border-line">
          {visible.map((repo, i) => (
            <li
              key={repo.repoId}
              id={`repo-${repo.repoId}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              className={`border-b border-line last:border-b-0 ${i === active ? "bg-ink-3" : ""}`}
            >
              <RepoItem repo={repo} highlighted={i === active} />
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 hidden text-[11px] text-dim md:block">
        <kbd className="border border-line px-1">/</kbd> search · <kbd className="border border-line px-1">↑</kbd>
        <kbd className="border border-line px-1">↓</kbd> move · <kbd className="border border-line px-1">↵</kbd> open
      </p>
    </div>
  );
}

function RepoItem({ repo, highlighted }: { repo: RepoRow; highlighted: boolean }) {
  return (
    <Link
      href={`/dashboard/${repo.repoId}`}
      tabIndex={-1}
      className="grid gap-x-6 gap-y-3 px-4 py-4 md:grid-cols-[minmax(0,1fr)_14rem_11rem_1.5rem] md:items-center"
    >
      <div className="flex min-w-0 gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={repo.ownerAvatar} alt="" width={32} height={32} className="mt-0.5 h-8 w-8 shrink-0 rounded-md border border-line" />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate font-display text-[17px]">
              <span className="text-muted">{repo.owner}/</span>
              <span className={highlighted ? "text-carrot" : ""}>{repo.name}</span>
            </span>
            {repo.private && <Pill>Private</Pill>}
            {!repo.canEdit && <Pill>Read-only</Pill>}
          </p>
          {repo.description && <p className="mt-0.5 truncate text-xs text-muted">{repo.description}</p>}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dim">
            {repo.language && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: LANGUAGE_COLORS[repo.language] ?? "var(--color-muted)" }}
                />
                {repo.language}
              </span>
            )}
            <span>Pushed {timeAgo(repo.pushedAt)}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] md:justify-start">
        <span
          className={`inline-flex items-center gap-1.5 border px-2 py-0.5 ${
            repo.enabled ? "border-add/40 text-add" : "border-line text-dim"
          }`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${repo.enabled ? "bg-add" : "bg-dim"}`} />
          {repo.enabled ? "Enabled" : "Paused"}
        </span>
        <span className="border border-line px-2 py-0.5 text-muted">{TRIGGER_SHORT[repo.trigger]}</span>
        <span className="border border-line px-2 py-0.5 text-muted capitalize">
          {repo.depth} · {repo.reviewerCount}
        </span>
      </div>

      <div className="text-[11px]">
        {repo.lastReview ? (
          <span className="flex items-center gap-2 text-muted">
            <span aria-hidden className={`h-2 w-2 rounded-full ${STATUS_DOT[repo.lastReview.status] ?? "bg-dim"}`} />
            <span>
              PR #{repo.lastReview.prNumber} · {repo.lastReview.status}
              <span className="block text-dim">{timeAgo(repo.lastReview.createdAtMs)}</span>
            </span>
          </span>
        ) : (
          <span className="text-dim">No reviews yet</span>
        )}
      </div>

      <span aria-hidden className={`hidden text-right md:block ${highlighted ? "text-carrot" : "text-dim"}`}>
        →
      </span>
    </Link>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="border border-line px-1.5 py-px text-[10px] tracking-wide text-muted uppercase">{children}</span>;
}
