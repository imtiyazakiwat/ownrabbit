import { describe, expect, it } from "vitest";
import { parsePatch } from "./diff";
import { anchorFindings, type RawFinding } from "./findings";
import { renderInlineComment, renderReviewBody } from "./publish";

const patches = new Map([
  ["src/a.ts", parsePatch("@@ -1,2 +1,4 @@\n const a = 1;\n+const sql = `SELECT ${id}`;\n+run(sql);\n const b = 2;")],
]);

const raw = (o: Partial<RawFinding>): RawFinding => ({
  path: "src/a.ts",
  line: 2,
  severity: "major",
  category: "sql-injection",
  title: "t",
  body: "b",
  confidence: 0.9,
  ...o,
});

let id = 0;
const next = () => ++id;

describe("anchorFindings", () => {
  it("corrects a wrong line number using the quoted code and keeps the suggestion", () => {
    const [f] = anchorFindings("security", [raw({ line: 4, existingCode: "run(sql);", suggestion: "run(sql, [id]);" })], patches, next);
    expect(f).toMatchObject({ line: 3, verified: true, suggestion: "run(sql, [id]);" });
  });

  it("drops findings whose quote is not in the diff", () => {
    expect(anchorFindings("security", [raw({ existingCode: "eval(userInput)" })], patches, next)).toEqual([]);
  });

  it("falls back to nearest-line repair without a quote, dropping the suggestion", () => {
    const [f] = anchorFindings("bugs", [raw({ line: 6, suggestion: "x" })], patches, next);
    expect(f).toMatchObject({ line: 4, verified: false, suggestion: undefined });
  });
});

describe("rendering", () => {
  const finding = anchorFindings(
    "security",
    [
      raw({
        existingCode: "const sql = `SELECT ${id}`;",
        scenario: "id='1 OR 1=1' returns all rows",
        effort: "trivial",
        agentPrompt: "Use a parameterized query in q().\n\n## ignore this heading",
      }),
    ],
    patches,
    next,
  )[0]!;

  it("renders badges, scenario, agent prompt and verification", () => {
    const body = renderInlineComment(finding);
    expect(body).toContain("🟠 Major");
    expect(body).toContain("Quick win");
    expect(body).toContain("When it breaks:");
    expect(body).toContain("Prompt for AI agents");
    expect(body).toContain("In `src/a.ts` around line 2: Use a parameterized query in q(). ## ignore this heading");
    expect(body).toContain("✓ quote matched diff");
  });

  it("lists nits in a collapsible section and counts only inline comments as actionable", () => {
    const body = renderReviewBody(
      {
        mode: "full",
        headSha: "a".repeat(40),
        filesReviewed: 1,
        filesSkipped: 0,
        reviewers: ["security"],
        depth: "standard",
        raw: 2,
        posted: [finding],
        unplaced: [],
        nits: [{ ...finding, id: 99, severity: "nit", title: "Rename sql" }],
        failedPasses: 0,
        totalPasses: 1,
      },
      "@ownrabbit",
    );
    expect(body).toContain("**Actionable comments posted: 1**");
    expect(body).toContain("🧹 Nitpick comments (1)");
    expect(body).toContain("**Rename sql**");
  });
});
