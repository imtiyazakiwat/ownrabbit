"use client";

import { DEFAULT_PAUSE_MESSAGE, type PauseState } from "@ownrabbit/core";
import { useState, useTransition } from "react";
import { timeAgo } from "@/lib/format";
import { setServicePause, type PauseResult } from "./actions";

interface FormState {
  paused: boolean;
  message: string;
  pausedBy?: string;
  pausedAtMs?: number;
  sweep?: PauseState["sweep"];
}

export function ServiceForm({ state }: { state: PauseState }) {
  const [draft, setDraft] = useState<FormState>(state);
  const [flash, setFlash] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const empty = draft.message.trim() === "";

  const setPaused = (paused: boolean) => {
    if (pending) return;
    startTransition(async () => {
      try {
        const result = await setServicePause({ paused, message: draft.message });
        if (result.ok) {
          setDraft(result.state);
          setFlash({
            tone: "ok",
            text: paused
              ? "Service paused. Posting the note on every open PR in the background."
              : "Service resumed. Reviews run as configured again.",
          });
        } else {
          setFlash({ tone: "err", text: result.error });
        }
      } catch {
        setFlash({ tone: "err", text: "Network error. Nothing was saved." });
      }
    });
  };

  return (
    <div className="mt-8 max-w-2xl space-y-4">
      <div className={`border p-5 ${draft.paused ? "border-warn/50 bg-warn/5" : "border-line bg-ink-2"}`}>
        <div className="flex items-baseline justify-between gap-4">
          <p className="font-display text-xl">
            {draft.paused ? <span className="text-warn">Paused</span> : <span className="text-add">Running</span>}
          </p>
          <p className="text-[11px] text-dim">
            {draft.paused
              ? draft.pausedAtMs
                ? `paused by @${draft.pausedBy ?? "unknown"} · ${timeAgo(draft.pausedAtMs)}`
                : "paused"
              : "reviews run as configured"}
          </p>
        </div>

        <label htmlFor="pause-message" className="mt-4 block text-xs text-muted">
          Pause note posted on pull requests
        </label>
        <textarea
          id="pause-message"
          rows={3}
          maxLength={1000}
          value={draft.message}
          placeholder={DEFAULT_PAUSE_MESSAGE}
          onChange={(e) => {
            setDraft((prev) => ({ ...prev, message: e.target.value }));
            setFlash(null);
          }}
          className="input mt-1.5 text-sm leading-6"
        />
        <div className="mt-1 flex justify-between text-[11px] text-dim">
          <span>{empty ? "Empty uses the default note." : "Plain text; shown verbatim in the PR comment."}</span>
          <span className={draft.message.length > 900 ? "text-warn" : ""}>{draft.message.length} / 1000</span>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {draft.paused ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() => setPaused(false)}
                className="inline-flex items-center gap-2 bg-add px-5 py-2 font-semibold text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? "Resuming…" : "Resume reviews"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setPaused(true)}
                className="border border-line px-4 py-2 text-sm text-muted transition hover:text-paper disabled:opacity-40"
              >
                Update note & re-post on open PRs
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => setPaused(true)}
              className="inline-flex items-center gap-2 bg-warn px-5 py-2 font-semibold text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? "Pausing…" : "Pause reviews"}
            </button>
          )}
        </div>

        {flash && (
          <p role="status" aria-live="polite" className={`mt-4 text-sm ${flash.tone === "err" ? "text-del" : "text-add"}`}>
            {flash.text}
          </p>
        )}
      </div>

      {draft.paused && draft.sweep && (
        <div className="border border-line bg-ink-2 px-5 py-4 text-sm">
          <p className="text-[10px] tracking-[0.18em] text-dim uppercase">Open-PR sweep</p>
          <p className="mt-1.5">
            {timeAgo(draft.sweep.atMs)}:{" "}
            <span className={draft.sweep.failed > 0 ? "text-warn" : "text-add"}>
              {draft.sweep.notified} of {draft.sweep.total} PRs notified
            </span>
            {draft.sweep.total === 0 && " · no open PRs found"}
            {draft.sweep.failed > 0 && ` · ${draft.sweep.failed} failed to post`}
          </p>
        </div>
      )}

      <p className="max-w-2xl text-[11px] leading-relaxed text-dim">
        While paused, new triggers never reach the worker — pull requests simply get the note. Jobs already queued are
        stopped the same way when the worker picks them up, so nothing retries.
      </p>
    </div>
  );
}
