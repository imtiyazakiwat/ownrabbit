"use client";

import {
  DEFAULT_EXCLUDES,
  DEPTH_PROFILES,
  DEPTHS,
  REVIEWER_INFO,
  REVIEWER_KINDS,
  SEVERITIES,
  TONES,
  type RepoSettings,
  type ReviewerKind,
} from "@ownrabbit/core";
import { useState, useTransition } from "react";
import { saveRepoSettings } from "../actions";

const TRIGGER_OPTIONS = [
  { value: "auto", label: "Automatic", hint: "Review when a PR opens and on every push." },
  { value: "mention", label: "On mention", hint: "Only when someone comments @mention." },
  { value: "both", label: "Both", hint: "Automatic, plus on-demand re-reviews." },
] as const;

const SEVERITY_LABEL = { critical: "Critical only", major: "Major +", minor: "Minor +", nit: "Everything" } as const;

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function SettingsForm({
  repoId,
  initial,
  canEdit,
}: {
  repoId: number;
  initial: RepoSettings;
  canEdit: boolean;
}) {
  const [s, setS] = useState(initial);
  const [include, setInclude] = useState(initial.includePaths.join("\n"));
  const [exclude, setExclude] = useState(initial.excludePaths.join("\n"));
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const disabled = !canEdit || pending;

  const set = <K extends keyof RepoSettings>(key: K, value: RepoSettings[K]) => {
    setS((prev) => ({ ...prev, [key]: value }));
    setStatus(null);
  };

  const toggleReviewer = (kind: ReviewerKind) => {
    const has = s.reviewers.includes(kind);
    if (has && s.reviewers.length === 1) {
      setStatus({ tone: "err", text: "Keep at least one reviewer enabled." });
      return;
    }
    set("reviewers", has ? s.reviewers.filter((k) => k !== kind) : REVIEWER_KINDS.filter((k) => k === kind || s.reviewers.includes(k)));
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const payload = { ...s, includePaths: lines(include), excludePaths: lines(exclude) };
    startTransition(async () => {
      try {
        const result = await saveRepoSettings(repoId, payload);
        if (result.ok) {
          setS(result.settings);
          setStatus({ tone: "ok", text: "Saved. Applies to the next review." });
        } else {
          setStatus({ tone: "err", text: result.error });
        }
      } catch {
        setStatus({ tone: "err", text: "Network error. Your changes were not saved." });
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-10" aria-busy={pending}>
      <fieldset disabled={!canEdit} className="space-y-10">
        <Section title="Status">
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
              className="h-4 w-4 accent-[var(--color-carrot)]"
            />
            <span>Reviews enabled for this repository</span>
          </label>
        </Section>

        <Section title="When to review">
          <div role="radiogroup" aria-label="Trigger" className="grid gap-2 sm:grid-cols-3">
            {TRIGGER_OPTIONS.map((o) => (
              <Choice
                key={o.value}
                name="trigger"
                checked={s.trigger === o.value}
                onChange={() => set("trigger", o.value)}
                label={o.label}
                hint={o.hint}
              />
            ))}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Check label="Review draft PRs" checked={s.reviewDrafts} onChange={(v) => set("reviewDrafts", v)} />
            <Check label="Skip PRs opened by bots" checked={s.skipBotPRs} onChange={(v) => set("skipBotPRs", v)} />
          </div>
        </Section>

        <Section title="How deep">
          <div role="radiogroup" aria-label="Depth" className="grid gap-2 sm:grid-cols-3">
            {DEPTHS.map((d) => (
              <Choice
                key={d}
                name="depth"
                checked={s.depth === d}
                onChange={() => set("depth", d)}
                label={DEPTH_PROFILES[d].label}
                hint={DEPTH_PROFILES[d].description}
              />
            ))}
          </div>
        </Section>

        <Section title={`Sub-reviewers (${s.reviewers.length})`} hint="Each runs in parallel with its own brief.">
          <div className="grid gap-2 sm:grid-cols-2">
            {REVIEWER_KINDS.map((kind) => (
              <label
                key={kind}
                className={`flex cursor-pointer gap-3 border p-3 transition ${
                  s.reviewers.includes(kind) ? "border-carrot bg-carrot-soft" : "border-line hover:border-muted"
                }`}
              >
                <input
                  type="checkbox"
                  checked={s.reviewers.includes(kind)}
                  onChange={() => toggleReviewer(kind)}
                  className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-carrot)]"
                />
                <span>
                  <span className="block font-display text-base">{REVIEWER_INFO[kind].label}</span>
                  <span className="block text-xs text-muted">{REVIEWER_INFO[kind].description}</span>
                </span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Noise control">
          <div className="grid gap-6 sm:grid-cols-2">
            <Field label={`Max comments per review: ${s.maxComments}`} htmlFor="maxComments">
              <input
                id="maxComments"
                type="range"
                min={1}
                max={50}
                value={s.maxComments}
                onChange={(e) => set("maxComments", Number(e.target.value))}
                className="w-full accent-[var(--color-carrot)]"
              />
            </Field>
            <Field label="Minimum severity" htmlFor="minSeverity">
              <select
                id="minSeverity"
                value={s.minSeverity}
                onChange={(e) => set("minSeverity", e.target.value as RepoSettings["minSeverity"])}
                className="input"
              >
                {SEVERITIES.map((sev) => (
                  <option key={sev} value={sev}>
                    {SEVERITY_LABEL[sev]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tone" htmlFor="tone">
              <select
                id="tone"
                value={s.tone}
                onChange={(e) => set("tone", e.target.value as RepoSettings["tone"])}
                className="input"
              >
                {TONES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Section>

        <Section title="Scope" hint="One glob per line. Excludes win over includes.">
          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="Include (empty = everything)" htmlFor="include">
              <textarea
                id="include"
                rows={5}
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                placeholder={"src/**\npackages/*/src/**"}
                className="input font-mono text-xs"
              />
            </Field>
            <Field label="Exclude" htmlFor="exclude">
              <textarea
                id="exclude"
                rows={5}
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
                className="input font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setExclude(DEFAULT_EXCLUDES.join("\n"))}
                className="mt-1 text-xs text-dim hover:text-carrot"
              >
                reset to defaults
              </button>
            </Field>
          </div>
        </Section>

        <Section title="House rules" hint="Plain-English instructions every reviewer follows.">
          <textarea
            aria-label="Custom review rules"
            rows={6}
            maxLength={8000}
            value={s.customRules}
            onChange={(e) => set("customRules", e.target.value)}
            placeholder={"- All DB access goes through repositories/, never raw SQL in handlers.\n- We use zod for validation; flag hand-rolled checks.\n- Don't comment on import order."}
            className="input text-sm"
          />
          <p className="mt-1 text-right text-xs text-dim">{s.customRules.length} / 8000</p>
        </Section>

        <Section title="Models">
          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="Review model" htmlFor="model">
              <input id="model" value={s.model} onChange={(e) => set("model", e.target.value)} className="input" />
            </Field>
            <Field label="Triage model" htmlFor="triageModel">
              <input
                id="triageModel"
                value={s.triageModel}
                onChange={(e) => set("triageModel", e.target.value)}
                className="input"
              />
            </Field>
          </div>
        </Section>
      </fieldset>

      {canEdit && (
        <div className="sticky bottom-0 -mx-2 flex items-center gap-4 border-t border-line bg-ink/95 px-2 py-4 backdrop-blur">
          <button
            type="submit"
            disabled={disabled}
            className="bg-carrot px-5 py-2 font-semibold text-ink transition hover:bg-paper disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save settings"}
          </button>
          <p role="status" aria-live="polite" className={`text-sm ${status?.tone === "err" ? "text-del" : "text-add"}`}>
            {status?.text}
          </p>
        </div>
      )}
    </form>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-xl">{title}</h2>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-2 block text-xs text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function Choice(props: { name: string; checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <label
      className={`flex cursor-pointer flex-col border p-3 transition ${
        props.checked ? "border-carrot bg-carrot-soft" : "border-line hover:border-muted"
      }`}
    >
      <span className="flex items-center gap-2">
        <input
          type="radio"
          name={props.name}
          checked={props.checked}
          onChange={props.onChange}
          className="accent-[var(--color-carrot)]"
        />
        <span className="font-display text-base">{props.label}</span>
      </span>
      <span className="mt-1 text-xs text-muted">{props.hint}</span>
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--color-carrot)]"
      />
      {label}
    </label>
  );
}
