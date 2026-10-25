import { defaultSettings, type RepoSettings, type ReviewJob } from "@ownrabbit/core";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ChatOptions, LlmClient } from "./llm";
import { runReviewPipeline, type ChangedFile, type GitHubPort, type StatePort } from "./orchestrator";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

const job = (overrides: Partial<ReviewJob> = {}): ReviewJob => ({
  jobId: "d1",
  installationId: 1,
  repoId: 2,
  owner: "o",
  repo: "r",
  prNumber: 3,
  headSha: HEAD,
  mode: "full",
  trigger: "auto",
  ...overrides,
});

const FILES: ChangedFile[] = [
  {
    filename: "src/db.ts",
    status: "modified",
    additions: 2,
    deletions: 0,
    patch: "@@ -1,2 +1,4 @@\n export function q(id) {\n+  const sql = `SELECT * FROM u WHERE id=${id}`;\n+  return run(sql);\n }",
  },
  { filename: "pnpm-lock.yaml", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
];

/** Routes by system prompt so each stage gets a deterministic reply. */
function fakeLlm(overrides: { reviewer?: unknown; judge?: unknown; fail?: RegExp } = {}): LlmClient & {
  calls: ChatOptions[];
} {
  const calls: ChatOptions[] = [];
  const respond = (options: ChatOptions): unknown => {
    const system = options.messages[0]?.content ?? "";
    if (overrides.fail?.test(system)) throw new Error("boom");
    if (system.includes("triage stage")) {
      return { summary: "Adds a query helper.", files: [{ path: "src/db.ts", summary: "query", risk: "high" }] };
    }
    if (system.includes("final quality gate")) return overrides.judge ?? { verdicts: [{ id: 1, keep: true }] };
    if (system.includes("summary comment")) return { markdown: "## Walkthrough\nAdds q()." };
    return (
      overrides.reviewer ?? {
        action: "final",
        findings: [
          {
            path: "src/db.ts",
            line: 2,
            severity: "critical",
            category: "sql-injection",
            title: "SQL injection via id",
            body: "`id` is interpolated into SQL.",
            suggestion: "  const sql = 'SELECT * FROM u WHERE id=?';",
            confidence: 0.95,
          },
          // Outside the diff entirely: must be dropped.
          { path: "src/db.ts", line: 90, severity: "major", category: "x", title: "far", body: "b", confidence: 0.9 },
          // Low confidence: must be dropped.
          { path: "src/db.ts", line: 3, severity: "minor", category: "y", title: "meh", body: "b", confidence: 0.2 },
        ],
      }
    );
  };
  return {
    calls,
    tokensUsed: 0,
    async chat(options) {
      calls.push(options);
      return JSON.stringify(respond(options));
    },
    async chatJson<T>(options: ChatOptions, schema: z.ZodType<T>) {
      calls.push(options);
      return schema.parse(respond(options));
    },
  };
}

function fakeGitHub(overrides: Partial<GitHubPort> = {}) {
  const reviews: Parameters<GitHubPort["createReview"]>[0][] = [];
  const summaries: string[] = [];
  const port: GitHubPort = {
    getPullRequest: async () => ({ number: 3, state: "open", title: "Add q", body: "", headSha: HEAD, baseSha: OLD }),
    listPullRequestFiles: async () => FILES,
    compareFiles: async () => ["src/db.ts"],
    upsertSummaryComment: async (body) => {
      summaries.push(body);
      return 42;
    },
    createReview: async (review) => {
      reviews.push(review);
    },
    ...overrides,
  };
  return { port, reviews, summaries };
}

function fakeState(lastReviewedSha?: string): StatePort & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    getLastReviewedSha: async () => lastReviewedSha,
    getSummaryCommentId: async () => undefined,
    saveState: async (s) => {
      saved.push(s);
    },
  };
}

const settings = (o: Partial<RepoSettings> = {}): RepoSettings => ({
  ...defaultSettings(),
  reviewers: ["security"],
  depth: "standard",
  ...o,
});

const noWorkspace = () => {
  throw new Error("workspace should not be needed");
};

function deps(o: {
  llm?: LlmClient;
  github?: GitHubPort;
  state?: StatePort;
  settings?: RepoSettings;
  job?: ReviewJob;
}) {
  return {
    job: o.job ?? job(),
    settings: o.settings ?? settings(),
    github: o.github ?? fakeGitHub().port,
    state: o.state ?? fakeState(),
    llm: o.llm ?? fakeLlm(),
    mention: "@ownrabbit",
    createWorkspace: () => ({
      readFile: async () => "",
      search: async () => "No matches",
      listDir: async () => "",
      dispose: vi.fn(async () => undefined),
    }),
    log: () => undefined,
  };
}

describe("runReviewPipeline", () => {
  it("posts one anchored inline comment with a suggestion and a summary", async () => {
    const gh = fakeGitHub();
    const state = fakeState();
    const result = await runReviewPipeline(deps({ github: gh.port, state }));

    expect(result).toEqual({ status: "completed", filesReviewed: 1, findingsRaw: 1, commentsPosted: 1 });
    expect(gh.summaries[0]).toContain("Adds q()");
    const review = gh.reviews[0]!;
    expect(review.commitId).toBe(HEAD);
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: "src/db.ts", line: 2, side: "RIGHT" });
    expect(review.comments[0]!.body).toContain("```suggestion");
    expect(review.body).toContain("@ownrabbit review");
    expect(state.saved.at(-1)).toEqual({ lastReviewedSha: HEAD, summaryCommentId: 42 });
  });

  it("never sends lockfiles to reviewers", async () => {
    const llm = fakeLlm();
    await runReviewPipeline(deps({ llm }));
    const reviewerPrompts = llm.calls.filter((c) => c.messages[0]!.content.includes("Your focus"));
    expect(reviewerPrompts.every((c) => !c.messages[1]!.content.includes("pnpm-lock.yaml"))).toBe(true);
  });

  it("drops findings the judge rejects", async () => {
    const gh = fakeGitHub();
    const llm = fakeLlm({ judge: { verdicts: [{ id: 1, keep: false, reason: "wrong" }] } });
    const result = await runReviewPipeline(deps({ llm, github: gh.port }));
    expect(result).toMatchObject({ status: "completed", commentsPosted: 0 });
    expect(gh.reviews[0]!.body).toContain("No issues found");
  });

  it("keeps findings if the judge itself fails", async () => {
    const llm = fakeLlm({ fail: /final quality gate/ });
    const result = await runReviewPipeline(deps({ llm }));
    expect(result).toMatchObject({ commentsPosted: 1 });
  });

  it("falls back to a body-only review when GitHub rejects inline comments", async () => {
    const posted: Parameters<GitHubPort["createReview"]>[0][] = [];
    const gh = fakeGitHub({
      createReview: async (review) => {
        if (review.comments.length > 0) throw Object.assign(new Error("Unprocessable"), { status: 422 });
        posted.push(review);
      },
    });
    await runReviewPipeline(deps({ github: gh.port }));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("SQL injection via id");
  });

  it("skips superseded auto reviews and closed PRs", async () => {
    expect(await runReviewPipeline(deps({ job: job({ headSha: OLD }) }))).toEqual({
      status: "skipped",
      reason: "superseded",
    });
    const closed = fakeGitHub({
      getPullRequest: async () => ({ number: 3, state: "closed", title: "", body: "", headSha: HEAD, baseSha: OLD }),
    });
    expect((await runReviewPipeline(deps({ github: closed.port }))).status).toBe("skipped");
  });

  it("incremental: reviews only files changed since the last reviewed sha", async () => {
    const compareFiles = vi.fn(async () => ["docs/readme.md"]);
    const gh = fakeGitHub({ compareFiles });
    const result = await runReviewPipeline(
      deps({ github: gh.port, state: fakeState(OLD), job: job({ mode: "incremental" }) }),
    );
    expect(compareFiles).toHaveBeenCalledWith(OLD, HEAD);
    expect(result).toEqual({ status: "skipped", reason: "no-reviewable-changes-since-last-review" });
  });

  it("incremental falls back to full after a force-push", async () => {
    const gh = fakeGitHub({ compareFiles: async () => undefined });
    const result = await runReviewPipeline(
      deps({ github: gh.port, state: fakeState(OLD), job: job({ mode: "incremental" }) }),
    );
    expect(result).toMatchObject({ status: "completed", filesReviewed: 1 });
  });

  it("survives a single reviewer failure but not all of them", async () => {
    const multi = settings({ reviewers: ["security", "bugs"] });
    const failSecurity = fakeLlm({ fail: /focus: security/ });
    expect((await runReviewPipeline(deps({ llm: failSecurity, settings: multi }))).status).toBe("completed");

    const failAll = fakeLlm({ fail: /Your focus/ });
    await expect(runReviewPipeline(deps({ llm: failAll, settings: multi }))).rejects.toThrow("All reviewers failed");
  });

  it("quick depth never creates a workspace", async () => {
    const d = { ...deps({ settings: settings({ depth: "quick" }) }), createWorkspace: noWorkspace };
    expect((await runReviewPipeline(d)).status).toBe("completed");
  });

  it("runs the tool loop and disposes the workspace", async () => {
    const steps = [
      { action: "search", pattern: "run(" },
      { action: "final", findings: [] },
    ];
    let i = 0;
    const llm = fakeLlm();
    const base = llm.chatJson.bind(llm);
    llm.chatJson = async (options, schema) =>
      options.messages[0]!.content.includes("Your focus") ? schema.parse(steps[i++]) : base(options, schema);

    const d = deps({ llm });
    const ws = d.createWorkspace();
    const search = vi.fn(async () => "src/db.ts:3: return run(sql);");
    const workspace = { ...ws, search };
    const result = await runReviewPipeline({ ...d, createWorkspace: () => workspace });
    expect(search).toHaveBeenCalledWith("run(", undefined);
    expect(workspace.dispose).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "completed", commentsPosted: 0 });
  });
});
