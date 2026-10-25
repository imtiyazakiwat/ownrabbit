import { describe, expect, it } from "vitest";
import { isValidRange, nearestCommentableLine, parsePatch, renderNumberedPatch } from "./diff";

const PATCH = [
  "@@ -1,4 +1,5 @@",
  " import a from 'a';",
  "-const x = 1;",
  "+const x = 2;",
  "+const y = 3;",
  " ",
  " export { x };",
  "\\ No newline at end of file",
  "@@ -20,2 +21,3 @@ function f() {",
  "   return 1;",
  "+  // added",
  " }",
  "",
].join("\n");

describe("parsePatch", () => {
  const parsed = parsePatch(PATCH);

  it("tracks new-file line numbers and stats", () => {
    expect(parsed.added).toBe(3);
    expect(parsed.removed).toBe(1);
    expect([...parsed.commentable.keys()]).toEqual([1, 2, 3, 4, 5, 21, 22, 23]);
  });

  it("handles empty / missing patches", () => {
    expect(parsePatch(undefined).hunks).toEqual([]);
    expect(parsePatch("").commentable.size).toBe(0);
  });

  it("validates ranges within a single hunk only", () => {
    expect(isValidRange(parsed, 3)).toBe(true);
    expect(isValidRange(parsed, 3, 2)).toBe(true);
    expect(isValidRange(parsed, 22, 4)).toBe(false); // spans hunks
    expect(isValidRange(parsed, 2, 3)).toBe(false); // inverted
    expect(isValidRange(parsed, 10)).toBe(false); // outside diff
  });

  it("finds a nearby commentable line", () => {
    expect(nearestCommentableLine(parsed, 3)).toBe(3);
    expect(nearestCommentableLine(parsed, 7)).toBe(5);
    expect(nearestCommentableLine(parsed, 13)).toBeUndefined();
  });

  it("renders deleted lines without numbers", () => {
    const text = renderNumberedPatch(parsed);
    expect(text).toContain("   2 +const x = 2;");
    expect(text).toContain("     -const x = 1;");
    expect(text).toContain("  22 +  // added");
  });
});
