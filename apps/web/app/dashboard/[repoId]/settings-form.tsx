"use client";

import {
  createPathFilter,
  DEFAULT_EXCLUDES,
  DEPTH_PROFILES,
  DEPTHS,
  matchPreset,
  PRESETS,
  REVIEWER_INFO,
  REVIEWER_KINDS,
  SEVERITIES,
  TONES,
  type RepoSettings,
  type ReviewerKind,
} from "@ownrabbit/core";
import { useEffect, useMemo, useState, useTransition } from "react";
import { saveRepoSettings } from "../actions";

// ------------------------------------------------------------------ copy

const TRIGGER_OPTIONS = [
  { value: "auto", label: "Automatic", hint: "When a PR opens, and again on every push." },
  { value: "mention", label: "On request", hint: "Only when a maintainer comments the mention." },
  { value: "both", label: "Both", hint: "Automatic, plus on-demand re-reviews." },
] as const;

const SEVERITY_META = {
  critical: { label: "Critical", tone: "text-del", bar: "bg-del" },
  major: { label: "Major", tone: "text-carrot", bar: "bg-carrot" },
  minor: { label: "Minor", tone: "text-warn", bar: "bg-warn" },
  nit: { label: "Nit", tone: "text-muted", bar: "bg-muted" },
} as const;

const TONE_SAMPLE = {
  concise: "`id` is interpolated into SQL. Use a bound parameter.",
  friendly: "Heads up: `id` ends up inside the SQL string here, so a crafted value could change the query. A bound parameter would close that off.",
  strict: "SQL injection: `id` is attacker-controlled and interpolated into the query. This must use a bound parameter before merge.",
} as const;

const DEPTH_GLYPH = { quick: 1, standard: 2, deep: 3 } as const;

const SECTIONS = [
  ["status", "Status"],
  ["presets", "Presets"],
  ["trigger", "When"],
  ["depth", "Depth"],
  ["reviewers", "Reviewers"],
  ["noise", "Noise"],
  ["scope", "Scope"],
  ["rules", "House rules"],
  ["models", "Models"],
] as const;

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

// ------------------------------------------------------------------ form

export function SettingsForm({
  repoId,
  initial,
  canEdit,
  mention,
}: {
  repoId: number;
  initial: RepoSettings;
  canEdit: boolean;
  mention: string;
}) {
  const [saved, setSaved] = useState(initial);
  const [s, setS] = useState(initial);
  const [include, setInclude] = useState(initial.includePaths.join("\n"));
  const [exclude, setExclude] = useState(initial.excludePaths.join("\n"));
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const draft: RepoSettings = useMemo(
    () => ({ ...s, includePaths: lines(include), excludePaths: lines(exclude) }),
    [s, include, exclude],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const preset = matchPreset(draft);

  // Warn before navigating away with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

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
    set("reviewers", REVIEWER_KINDS.filter((k) => (k === kind ? !has : s.reviewers.includes(k))));
  };

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setS((prev) => ({ ...prev, ...p.values, reviewers: [...p.values.reviewers] }));
    setStatus(null);
  };

  const discard = () => {
    setS(saved);
    setInclude(saved.includePaths.join("\n"));
    setExclude(saved.excludePaths.join("\n"));
    setStatus(null);
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canEdit || pending || !dirty) return;
    startTransition(async () => {
      try {
        const result = await saveRepoSettings(repoId, draft);
        if (result.ok) {
          setSaved(result.settings);
          setS(result.settings);
          setInclude(result.settings.includePaths.join("\n"));
          setExclude(result.settings.excludePaths.join("\n"));
          setStatus({ tone: "ok", text: "Saved. Applies from the next review." });
        } else {
          setStatus({ tone: "err", text: result.error });
        }
      } catch {
        setStatus({ tone: "err", text: "Network error. Nothing was saved." });
      }
    });
  };

  // ⌘/Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        (document.getElementById("settings-form") as HTMLFormElement | null)?.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="grid gap-10 xl:grid-cols-[9rem_minmax(0,1fr)_22rem]">
      {/* ---- section nav */}
      <nav aria-label="Settings sections" className="hidden xl:block">
        <ol className="sticky top-6 space-y-1 border-l border-line text-xs">
          {SECTIONS.map(([id, label], i) => (
            <li key={id}>
              <a href={`#${id}`} className="-ml-px flex gap-2 border-l border-transparent py-1 pl-3 text-muted hover:border-carrot hover:text-paper">
                <span className="text-dim tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                {label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {/* ---- form */}
      <form id="settings-form" onSubmit={onSubmit} aria-busy={pending} className="min-w-0">
        <fieldset disabled={!canEdit} className="space-y-14">
          <Section id="status" n={1} title="Status">
            <Toggle
              checked={s.enabled}
              onChange={(v) => set("enabled", v)}
              label={s.enabled ? "Reviews are on" : "Reviews are paused"}
              hint={s.enabled ? "OwnRabbit will review pull requests in this repository." : "Nothing will be reviewed until you turn this back on."}
            />
          </Section>

          <Section id="presets" n={2} title="Start from a preset" hint="Sets depth, reviewers, and noise controls in one go. Fine-tune below.">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p.id)}
                  aria-pressed={preset === p.id}
                  className={`group border p-3 text-left transition ${
                    preset === p.id ? "border-carrot bg-carrot-soft" : "border-line hover:border-muted"
                  }`}
                >
                  <span className="flex items-center justify-between font-display text-base">
                    {p.label}
                    {preset === p.id && <span className="text-xs text-carrot">●</span>}
                  </span>
                  <span className="mt-1 block text-[11px] leading-snug text-muted">{p.blurb}</span>
                </button>
              ))}
            </div>
            {!preset && <p className="mt-2 text-[11px] text-dim">Custom configuration.</p>}
          </Section>

          <Section id="trigger" n={3} title="When to review">
            <RadioCards
              name="trigger"
              value={s.trigger}
              onChange={(v) => set("trigger", v as RepoSettings["trigger"])}
              options={TRIGGER_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
                hint: o.hint.replace("the mention", mention),
              }))}
            />
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Toggle small checked={s.reviewDrafts} onChange={(v) => set("reviewDrafts", v)} label="Review draft PRs" />
              <Toggle small checked={s.skipBotPRs} onChange={(v) => set("skipBotPRs", v)} label="Skip PRs opened by bots" />
            </div>
          </Section>

          <Section id="depth" n={4} title="How deep">
            <RadioCards
              name="depth"
              value={s.depth}
              onChange={(v) => set("depth", v as RepoSettings["depth"])}
              options={DEPTHS.map((d) => ({
                value: d,
                label: DEPTH_PROFILES[d].label,
                hint: DEPTH_PROFILES[d].description,
                adornment: <DepthMeter level={DEPTH_GLYPH[d]} />,
                meta: DEPTH_PROFILES[d].toolSteps
                  ? `up to ${DEPTH_PROFILES[d].toolSteps} lookups / reviewer`
                  : "diff only",
              }))}
            />
          </Section>

          <Section id="reviewers" n={5} title="Sub-reviewers" hint="Each specialist runs in parallel with its own brief, then a judge merges their findings.">
            <div className="grid gap-2 sm:grid-cols-2">
              {REVIEWER_KINDS.map((kind, i) => {
                const on = s.reviewers.includes(kind);
                return (
                  <label
                    key={kind}
                    className={`relative flex cursor-pointer gap-3 border p-4 transition ${
                      on ? "border-carrot bg-carrot-soft" : "border-line hover:border-muted"
                    }`}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggleReviewer(kind)} className="peer sr-only" />
                    <span
                      aria-hidden
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border text-[11px] peer-focus-visible:outline-2 peer-focus-visible:outline-carrot ${
                        on ? "border-carrot bg-carrot text-ink" : "border-line text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-baseline gap-2">
                        <span className="font-display text-base">{REVIEWER_INFO[kind].label}</span>
                        <span className="text-[10px] text-dim">agent {String(i + 1).padStart(2, "0")}</span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-snug text-muted">{REVIEWER_INFO[kind].description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </Section>

          <Section id="noise" n={6} title="Noise control" hint="Fewer, sharper comments get read. More get ignored.">
            <div className="space-y-8">
              <div>
                <div className="flex items-baseline justify-between">
                  <label htmlFor="maxComments" className="text-xs text-muted">
                    Comment budget per review
                  </label>
                  <output htmlFor="maxComments" className="font-display text-2xl tabular-nums">
                    {s.maxComments}
                  </output>
                </div>
                <input
                  id="maxComments"
                  type="range"
                  min={1}
                  max={50}
                  value={s.maxComments}
                  onChange={(e) => set("maxComments", Number(e.target.value))}
                  className="mt-2 w-full accent-[var(--color-carrot)]"
                />
                <div className="flex justify-between text-[10px] text-dim">
                  <span>1 · surgical</span>
                  <span>50 · exhaustive</span>
                </div>
              </div>

              <div>
                <p id="sev-label" className="text-xs text-muted">
                  Post findings at or above
                </p>
                <div role="radiogroup" aria-labelledby="sev-label" className="mt-2 grid grid-cols-4 border border-line">
                  {SEVERITIES.map((sev, i) => {
                    const included = SEVERITIES.indexOf(s.minSeverity) >= i;
                    const selected = s.minSeverity === sev;
                    return (
                      <button
                        key={sev}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => set("minSeverity", sev)}
                        className={`relative border-r border-line px-2 py-3 text-xs transition last:border-r-0 ${
                          selected ? "bg-ink-3" : "hover:bg-ink-2"
                        }`}
                      >
                        <span
                          aria-hidden
                          className={`absolute inset-x-0 top-0 h-0.5 ${included ? SEVERITY_META[sev].bar : "bg-transparent"}`}
                        />
                        <span className={included ? SEVERITY_META[sev].tone : "text-dim"}>{SEVERITY_META[sev].label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[11px] text-dim">
                  {s.minSeverity === "critical"
                    ? "Only critical issues will be posted."
                    : `${SEVERITIES.slice(0, SEVERITIES.indexOf(s.minSeverity) + 1).map((x) => SEVERITY_META[x].label).join(", ")} will be posted.`}
                </p>
              </div>

              <div>
                <p id="tone-label" className="text-xs text-muted">
                  Voice
                </p>
                <div role="radiogroup" aria-labelledby="tone-label" className="mt-2 grid gap-2 sm:grid-cols-3">
                  {TONES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={s.tone === t}
                      onClick={() => set("tone", t)}
                      className={`border px-3 py-2 text-left text-sm capitalize transition ${
                        s.tone === t ? "border-carrot bg-carrot-soft" : "border-line hover:border-muted"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Section>

          <Section id="scope" n={7} title="Scope" hint="One glob per line. Excludes win over includes.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Include" sub="empty = everything" htmlFor="include">
                <textarea
                  id="include"
                  rows={6}
                  value={include}
                  onChange={(e) => setInclude(e.target.value)}
                  placeholder={"src/**\npackages/*/src/**"}
                  spellCheck={false}
                  className="input font-mono text-xs leading-5"
                />
              </Field>
              <Field
                label="Exclude"
                sub={
                  <button type="button" onClick={() => setExclude(DEFAULT_EXCLUDES.join("\n"))} className="hover:text-carrot">
                    reset to defaults
                  </button>
                }
                htmlFor="exclude"
              >
                <textarea
                  id="exclude"
                  rows={6}
                  value={exclude}
                  onChange={(e) => setExclude(e.target.value)}
                  spellCheck={false}
                  className="input font-mono text-xs leading-5"
                />
              </Field>
            </div>
            <PathTester includePaths={draft.includePaths} excludePaths={draft.excludePaths} />
          </Section>

          <Section id="rules" n={8} title="House rules" hint="Plain-English instructions every reviewer follows. They take priority over the defaults.">
            <textarea
              aria-label="House rules"
              rows={7}
              maxLength={8000}
              value={s.customRules}
              onChange={(e) => set("customRules", e.target.value)}
              placeholder={"- All DB access goes through repositories/, never raw SQL in handlers.\n- We validate input with zod; flag hand-rolled checks.\n- Don't comment on import order."}
              className="input text-sm leading-6"
            />
            <div className="mt-1 flex justify-between text-[11px] text-dim">
              <span>Tip: be specific. “Prefer early returns” beats “write clean code”.</span>
              <span className={s.customRules.length > 7500 ? "text-warn" : ""}>{s.customRules.length} / 8000</span>
            </div>
          </Section>

          <Section id="models" n={9} title="Models" hint="Any model id your configured endpoint serves.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Review model" sub="specialists, judge, summary" htmlFor="model">
                <input id="model" value={s.model} onChange={(e) => set("model", e.target.value)} spellCheck={false} className="input font-mono text-xs" />
              </Field>
              <Field label="Triage model" sub="fast pre-pass" htmlFor="triageModel">
                <input
                  id="triageModel"
                  value={s.triageModel}
                  onChange={(e) => set("triageModel", e.target.value)}
                  spellCheck={false}
                  className="input font-mono text-xs"
                />
              </Field>
            </div>
          </Section>
        </fieldset>

        {canEdit && (
          <div
            className={`sticky bottom-4 z-10 mt-14 flex flex-wrap items-center gap-4 border px-4 py-3 shadow-[0_12px_40px_-12px_#000] backdrop-blur transition ${
              dirty ? "border-carrot bg-ink/95" : "border-line bg-ink/80"
            }`}
          >
            <p role="status" aria-live="polite" className="mr-auto text-sm">
              {status ? (
                <span className={status.tone === "err" ? "text-del" : "text-add"}>{status.text}</span>
              ) : dirty ? (
                <span className="text-paper">
                  <span className="text-carrot">●</span> Unsaved changes
                </span>
              ) : (
                <span className="text-dim">All changes saved</span>
              )}
            </p>
            {dirty && (
              <button type="button" onClick={discard} disabled={pending} className="px-3 py-2 text-sm text-muted hover:text-paper">
                Discard
              </button>
            )}
            <button
              type="submit"
              disabled={pending || !dirty}
              className="inline-flex items-center gap-2 bg-carrot px-5 py-2 font-semibold text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? "Saving…" : "Save"}
              <kbd className="border border-ink/30 px-1 text-[10px] font-normal">⌘S</kbd>
            </button>
          </div>
        )}
      </form>

      {/* ---- live preview */}
      <aside aria-label="Preview" className="hidden xl:block">
        <div className="sticky top-6 space-y-4">
          <ReviewPreview settings={draft} mention={mention} />
        </div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ preview

function ReviewPreview({ settings, mention }: { settings: RepoSettings; mention: string }) {
  const profile = DEPTH_PROFILES[settings.depth];
  const stages = [
    { name: "Triage", detail: settings.triageModel, on: true },
    ...settings.reviewers.map((r) => ({ name: REVIEWER_INFO[r].label, detail: profile.toolSteps ? `${profile.toolSteps} lookups` : "diff only", on: true, indent: true })),
    { name: "Judge", detail: profile.useJudge ? "filters noise" : "skipped on quick", on: profile.useJudge },
    { name: "Post", detail: `≤ ${settings.maxComments} comments`, on: true },
  ];

  return (
    <>
      <div className="border border-line bg-ink-2">
        <p className="border-b border-line px-4 py-2 text-[10px] tracking-[0.2em] text-dim uppercase">Pipeline preview</p>
        <ol className="px-4 py-3 text-xs">
          {stages.map((st, i) => (
            <li key={`${st.name}-${i}`} className={`flex items-center justify-between gap-3 py-1 ${"indent" in st && st.indent ? "pl-4" : ""}`}>
              <span className={`flex items-center gap-2 ${st.on ? "" : "text-dim line-through"}`}>
                <span aria-hidden className={st.on ? "text-carrot" : "text-dim"}>
                  {"indent" in st && st.indent ? "├" : "●"}
                </span>
                {st.name}
              </span>
              <span className="truncate text-[10px] text-dim">{st.detail}</span>
            </li>
          ))}
        </ol>
        <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
          {settings.enabled
            ? settings.trigger === "mention"
              ? `Runs when a maintainer comments ${mention}.`
              : settings.trigger === "auto"
                ? "Runs on every PR open and push."
                : `Runs on every push, or on ${mention}.`
            : "Paused: nothing will run."}
        </p>
      </div>

      <div className="border border-line bg-ink-2">
        <p className="border-b border-line px-4 py-2 text-[10px] tracking-[0.2em] text-dim uppercase">A comment, in this voice</p>
        <div className="m-3 border-l-2 border-del bg-ink-3 p-3">
          <p className="text-[11px]">
            <span className="text-del">● Critical</span> <span className="text-dim">· security</span>
          </p>
          <p className="mt-1 font-display text-sm">SQL injection through the user id</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">{TONE_SAMPLE[settings.tone]}</p>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ pieces

function PathTester({ includePaths, excludePaths }: { includePaths: string[]; excludePaths: string[] }) {
  const [path, setPath] = useState("src/app/page.tsx");
  const result = useMemo(() => {
    const trimmed = path.trim().replace(/^\/+/, "");
    if (!trimmed) return null;
    try {
      return createPathFilter({ includePaths, excludePaths })(trimmed);
    } catch {
      return null;
    }
  }, [path, includePaths, excludePaths]);

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border border-dashed border-line px-3 py-2">
      <label htmlFor="path-test" className="text-[11px] text-dim">
        Test a path
      </label>
      <input
        id="path-test"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent font-mono text-xs focus:outline-none"
      />
      {result !== null && (
        <span className={`text-xs ${result ? "text-add" : "text-del"}`} aria-live="polite">
          {result ? "✓ reviewed" : "✕ skipped"}
        </span>
      )}
    </div>
  );
}

function Section({
  id,
  n,
  title,
  hint,
  children,
}: {
  id: string;
  n: number;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <div className="mb-5 flex items-baseline gap-3 border-b border-line pb-3">
        <span className="text-xs text-carrot tabular-nums">{String(n).padStart(2, "0")}</span>
        <div>
          <h2 id={`${id}-title`} className="font-display text-2xl">
            {title}
          </h2>
          {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, sub, htmlFor, children }: { label: string; sub?: React.ReactNode; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs text-muted">
          {label}
        </label>
        {sub && <span className="text-[10px] text-dim">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function RadioCards({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; hint: string; adornment?: React.ReactNode; meta?: string }[];
}) {
  return (
    <div role="radiogroup" aria-label={name} className="grid gap-2 sm:grid-cols-3">
      {options.map((o) => {
        const checked = value === o.value;
        return (
          <label
            key={o.value}
            className={`relative flex cursor-pointer flex-col border p-4 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-carrot ${
              checked ? "border-carrot bg-carrot-soft" : "border-line hover:border-muted"
            }`}
          >
            <input type="radio" name={name} checked={checked} onChange={() => onChange(o.value)} className="sr-only" />
            <span className="flex items-center justify-between">
              <span className="font-display text-lg">{o.label}</span>
              {o.adornment}
            </span>
            <span className="mt-1 text-xs leading-snug text-muted">{o.hint}</span>
            {o.meta && <span className="mt-3 text-[10px] tracking-wide text-dim uppercase">{o.meta}</span>}
            {checked && <span aria-hidden className="absolute top-0 left-0 h-full w-0.5 bg-carrot" />}
          </label>
        );
      })}
    </div>
  );
}

function DepthMeter({ level }: { level: 1 | 2 | 3 }) {
  return (
    <span aria-hidden className="flex items-end gap-0.5">
      {[1, 2, 3].map((i) => (
        <span key={i} className={`w-1 ${i <= level ? "bg-carrot" : "bg-line"}`} style={{ height: `${4 + i * 4}px` }} />
      ))}
    </span>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  small,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  small?: boolean;
}) {
  return (
    <label className={`flex cursor-pointer items-center gap-4 ${small ? "" : "border border-line p-4"}`}>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden
        className={`relative h-5 w-9 shrink-0 border transition peer-focus-visible:outline-2 peer-focus-visible:outline-carrot ${
          checked ? "border-carrot bg-carrot" : "border-line bg-ink-3"
        }`}
      >
        <span className={`absolute top-0.5 h-3.5 w-3.5 transition-all ${checked ? "left-[18px] bg-ink" : "left-0.5 bg-muted"}`} />
      </span>
      <span>
        <span className={small ? "text-sm" : "font-display text-lg"}>{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}
