"use client";

import {
  DEFAULT_FREE_MODEL,
  FREE_MODELS,
  RECOMMENDED_FREE_MODELS,
  freeModel,
  type ReviewModelConfig,
} from "@ownrabbit/core";
import { useState, useTransition } from "react";
import { setReviewModel } from "./actions";

export function ReviewModelForm({ initial }: { initial: ReviewModelConfig }) {
  const [saved, setSaved] = useState(initial.defaultModel);
  const [model, setModel] = useState(initial.defaultModel);
  const [flash, setFlash] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const recommended = new Set(RECOMMENDED_FREE_MODELS.map((m) => m.id));
  const others = FREE_MODELS.filter((m) => !recommended.has(m.id));
  const current = freeModel(saved);

  const save = () => {
    if (pending || model === saved) return;
    startTransition(async () => {
      try {
        const result = await setReviewModel({ defaultModel: model });
        if (result.ok) {
          setSaved(defaultModelValue(result.defaultModel));
          setFlash({ tone: "ok", text: "Default model saved. Repositories without an override use it from the next review." });
        } else {
          setFlash({ tone: "err", text: result.error });
        }
      } catch {
        setFlash({ tone: "err", text: "Network error. Nothing was saved." });
      }
    });
  };

  return (
    <div className="mt-8 max-w-2xl border border-line bg-ink-2 p-5">
      <p className="font-display text-xl">Default review model</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Every repository without an override uses this model. Maintainers may choose any free model for their repository,
        but paid models are not available.
      </p>

      <label htmlFor="default-model" className="mt-4 block text-xs text-muted">
        Platform default
      </label>
      <select
        id="default-model"
        value={model}
        onChange={(e) => {
          setModel(e.target.value as typeof model);
          setFlash(null);
        }}
        className="input mt-1.5 font-mono text-xs"
      >
        <optgroup label="Recommended">
          {RECOMMENDED_FREE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {Math.round(m.context / 1000)}k ctx
            </option>
          ))}
        </optgroup>
        <optgroup label="All free models">
          {others.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {Math.round(m.context / 1000)}k ctx
            </option>
          ))}
        </optgroup>
      </select>

      <p className="mt-2 text-[11px] text-dim">
        Current: <span className="text-muted">{current.name}</span> · {current.id}
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || model === saved}
          onClick={save}
          className="inline-flex items-center gap-2 bg-carrot px-5 py-2 font-semibold text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save default"}
        </button>
        {model !== saved && (
          <button
            type="button"
            onClick={() => {
              setModel(defaultModelValue(saved));
              setFlash(null);
            }}
            className="px-3 py-2 text-sm text-muted hover:text-paper"
          >
            Discard
          </button>
        )}
      </div>

      {flash && (
        <p role="status" aria-live="polite" className={`mt-4 text-sm ${flash.tone === "err" ? "text-del" : "text-add"}`}>
          {flash.text}
        </p>
      )}
    </div>
  );
}

function defaultModelValue(value: string): ReviewModelConfig["defaultModel"] {
  return FREE_MODELS.some((m) => m.id === value) ? (value as ReviewModelConfig["defaultModel"]) : DEFAULT_FREE_MODEL;
}
