import { describe, expect, it } from "vitest";
import { matchPreset, PRESETS } from "./presets";
import { defaultSettings, RepoSettingsSchema } from "./settings";

describe("presets", () => {
  it("every preset produces valid settings", () => {
    for (const p of PRESETS) {
      expect(RepoSettingsSchema.safeParse({ ...defaultSettings(), ...p.values }).success).toBe(true);
    }
  });

  it("defaults match the balanced preset", () => {
    expect(matchPreset(defaultSettings())).toBe("balanced");
  });

  it("matches regardless of reviewer order and detects custom configs", () => {
    const security = PRESETS.find((p) => p.id === "security")!;
    const reordered = { ...defaultSettings(), ...security.values, reviewers: [...security.values.reviewers].reverse() };
    expect(matchPreset(reordered)).toBe("security");
    expect(matchPreset({ ...defaultSettings(), maxComments: 7 })).toBeUndefined();
  });
});
