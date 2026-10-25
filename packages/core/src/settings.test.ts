import { describe, expect, it } from "vitest";
import { createPathFilter } from "./paths";
import { DEFAULT_EXCLUDES, defaultSettings, resolveSettings, RepoSettingsSchema } from "./settings";

describe("settings", () => {
  it("produces sane defaults", () => {
    const s = defaultSettings();
    expect(s.trigger).toBe("both");
    expect(s.depth).toBe("standard");
    expect(s.reviewers).toEqual(["security", "bugs", "performance"]);
    expect(s.excludePaths).toEqual(DEFAULT_EXCLUDES);
  });

  it("handles null / undefined / non-object input", () => {
    expect(resolveSettings(undefined)).toEqual(defaultSettings());
    expect(resolveSettings(null)).toEqual(defaultSettings());
    expect(resolveSettings("garbage")).toEqual(defaultSettings());
  });

  it("keeps valid fields and resets only invalid ones", () => {
    const s = resolveSettings({ depth: "deep", trigger: "nonsense", maxComments: 999 });
    expect(s.depth).toBe("deep");
    expect(s.trigger).toBe("both");
    expect(s.maxComments).toBe(15);
  });

  it("dedupes reviewers and rejects an empty list", () => {
    expect(RepoSettingsSchema.parse({ reviewers: ["bugs", "bugs"] }).reviewers).toEqual(["bugs"]);
    expect(RepoSettingsSchema.safeParse({ reviewers: [] }).success).toBe(false);
  });

  it("rejects suspicious model ids", () => {
    expect(RepoSettingsSchema.safeParse({ model: "a b; rm -rf" }).success).toBe(false);
  });
});

describe("createPathFilter", () => {
  it("excludes lockfiles and dist by default", () => {
    const keep = createPathFilter(defaultSettings());
    expect(keep("src/index.ts")).toBe(true);
    expect(keep("pnpm-lock.yaml")).toBe(false);
    expect(keep("packages/a/dist/index.js")).toBe(false);
    expect(keep(".github/workflows/ci.yml")).toBe(true);
  });

  it("applies includes, and excludes win", () => {
    const keep = createPathFilter({ includePaths: ["src/**"], excludePaths: ["src/gen/**"] });
    expect(keep("src/a.ts")).toBe(true);
    expect(keep("docs/a.md")).toBe(false);
    expect(keep("src/gen/a.ts")).toBe(false);
  });
});
