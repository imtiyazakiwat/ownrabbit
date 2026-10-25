import type { RepoSettings } from "./settings";

export type PresetId = "balanced" | "security" | "light" | "strict";

export interface Preset {
  id: PresetId;
  label: string;
  blurb: string;
  values: Pick<RepoSettings, "depth" | "reviewers" | "maxComments" | "minSeverity" | "tone">;
}

/** Opinionated starting points. Applying one only touches the fields listed in `values`. */
export const PRESETS: Preset[] = [
  {
    id: "balanced",
    label: "Balanced",
    blurb: "Good default for most product code.",
    values: {
      depth: "standard",
      reviewers: ["security", "bugs", "performance"],
      maxComments: 15,
      minSeverity: "minor",
      tone: "concise",
    },
  },
  {
    id: "security",
    label: "Security-first",
    blurb: "Auth, payments, anything handling user data.",
    values: { depth: "deep", reviewers: ["security", "bugs"], maxComments: 20, minSeverity: "minor", tone: "strict" },
  },
  {
    id: "light",
    label: "Light touch",
    blurb: "Docs sites, prototypes, low-risk repos.",
    values: { depth: "quick", reviewers: ["bugs"], maxComments: 5, minSeverity: "major", tone: "friendly" },
  },
  {
    id: "strict",
    label: "Full audit",
    blurb: "Every specialist, deep exploration, every nit.",
    values: {
      depth: "deep",
      reviewers: ["security", "bugs", "performance", "style", "tests"],
      maxComments: 40,
      minSeverity: "nit",
      tone: "strict",
    },
  },
];

/** The preset whose values exactly match the settings, if any. */
export function matchPreset(settings: RepoSettings): PresetId | undefined {
  return PRESETS.find((p) => {
    const v = p.values;
    return (
      v.depth === settings.depth &&
      v.maxComments === settings.maxComments &&
      v.minSeverity === settings.minSeverity &&
      v.tone === settings.tone &&
      v.reviewers.length === settings.reviewers.length &&
      v.reviewers.every((r) => settings.reviewers.includes(r))
    );
  })?.id;
}
