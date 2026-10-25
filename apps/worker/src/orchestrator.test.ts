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
function fakeLlm(
  overrides: { reviewer?: unknown; judge?: unknown; principal?: unknown | unknown[]; fail?: RegExp } = {},
): LlmClient & {
  calls: ChatOptions[];
} {
  const calls: ChatOptions[] = [];
  let principalStep = 0;
  const respond = (options: ChatOptions): unknown => {
    const system = options.messages[0]?.content ?? "";
    if (overrides.fail?.test(system)) throw new Error("boom");
    if (system.includes("triage stage")) {
      return { summary: "Adds a query helper.", files: [{ path: "src/db.ts", summary: "query", risk: "high" }] };
    }
    if (system.includes("final quality gate")) return overrides.judge ?? { verdicts: [{ id: 1, keep: true }] };
    if (system.includes("principal reviewer")) {
      // An array scripts a multi-turn agent run; each call takes the next step.
      if (Array.isArray(overrides.principal)) return overrides.principal[principalStep++] ?? { action: "final" };
      return overrides.principal ?? { action: "final", verdictReason: "ok" };
    }
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

function fakeGitHub(overrides: Partial<GitHubPort> = {}, repoFiles: Record<string, string> = {}) {
  const reviews: Parameters<GitHubPort["createReview"]>[0][] = [];
  const summaries: string[] = [];
  const dismissals: string[] = [];
  const reads: { path: string; ref: string }[] = [];
  const port: GitHubPort = {
    readFile: async (path, ref) => {
      reads.push({ path, ref });
      return repoFiles[path];
    },
    listDir: async (dir) =>
      Object.keys(repoFiles)
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1)),
    dismissStaleChangeRequests: async (message) => {
      dismissals.push(message);
      return 1;
    },
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
  return { port, reviews, summaries, dismissals, reads };
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
  principalReview: false,
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

    expect(result).toEqual({ status: "completed", filesReviewed: 1, findingsRaw: 1, commentsPosted: 1, failedPasses: 0 });
    expect(gh.summaries[0]).toContain("Adds q()");
    const review = gh.reviews[0]!;
    expect(review.commitId).toBe(HEAD);
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: "src/db.ts", line: 2, side: "RIGHT" });
    expect(review.comments[0]!.body).toContain("```suggestion");
    expect(review.body).toContain("@ownrabbit review");
    expect(state.saved.at(-1)).toEqual({ lastReviewedSha: HEAD, summaryCommentId: 42 });
  });

  it("reports each stage to the run monitor", async () => {
    const stages: string[] = [];
    const errors: string[] = [];
    const run = { stage: (name: string) => void stages.push(name), log: (level: string, m: string) => void (level === "error" && errors.push(m)) };
    const multi = settings({ reviewers: ["security", "bugs"] });
    await runReviewPipeline({ ...deps({ settings: multi, llm: fakeLlm({ fail: /focus: correctness/ }) }), run });
    expect(stages).toEqual(["load", "triage", "review", "judge", "publish"]);
    expect(errors.some((m) => m.startsWith("bugs failed"))).toBe(true);
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

  it("uses the judge score over its keep flag", async () => {
    const low = fakeLlm({ judge: { verdicts: [{ id: 1, keep: true, score: 4 }] } });
    expect(await runReviewPipeline(deps({ llm: low }))).toMatchObject({ commentsPosted: 0 });
    const high = fakeLlm({ judge: { verdicts: [{ id: 1, keep: false, score: 9 }] } });
    expect(await runReviewPipeline(deps({ llm: high }))).toMatchObject({ commentsPosted: 1 });
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

  it("fails the job only when every reviewer pass fails", async () => {
    const multi = settings({ reviewers: ["security", "bugs"] });
    const failAll = fakeLlm({ fail: /Your focus/ });
    await expect(runReviewPipeline(deps({ llm: failAll, settings: multi }))).rejects.toThrow("All reviewers failed");
  });

  it("marks a review partial, says so on the PR, and does not advance the incremental cursor", async () => {
    const gh = fakeGitHub();
    const state = fakeState(OLD);
    const multi = settings({ reviewers: ["security", "bugs"] });
    const llm = fakeLlm({ fail: /focus: correctness/ });
    const result = await runReviewPipeline(deps({ llm, github: gh.port, state, settings: multi }));

    expect(result).toMatchObject({ status: "completed", failedPasses: 1 });
    const body = gh.reviews[0]!.body;
    expect(body).toContain("Partial review");
    expect(body).toContain("1 of 2 reviewer passes failed");
    // Only the summary id is persisted; the cursor stays put.
    expect(state.saved).toEqual([{ summaryCommentId: 42 }]);
  });

  it("retries a transiently failing reviewer pass once", async () => {
    let calls = 0;
    const llm = fakeLlm();
    const base = llm.chatJson.bind(llm);
    llm.chatJson = async (options, schema) => {
      if (options.messages[0]!.content.includes("Your focus") && calls++ === 0) throw new Error("502 upstream");
      return base(options, schema);
    };
    const gh = fakeGitHub();
    const result = await runReviewPipeline(deps({ llm, github: gh.port }));
    expect(result).toMatchObject({ status: "completed", failedPasses: 0, commentsPosted: 1 });
    expect(gh.reviews[0]!.body).not.toContain("Partial review");
  });

  it("quick depth never creates a workspace", async () => {
    const d = { ...deps({ settings: settings({ depth: "quick" }) }), createWorkspace: noWorkspace };
    expect((await runReviewPipeline(d)).status).toBe("completed");
  });

  describe("principal pass", () => {
    const on = (o: Partial<RepoSettings> = {}) => settings({ principalReview: true, ...o });

    it("writes a playbook review and requests changes when a critical finding survives", async () => {
      const gh = fakeGitHub();
      const llm = fakeLlm({
        principal: {
          action: "final",
          // The model says approve; the surviving critical finding must win.
          verdict: "APPROVE",
          verdictReason: "Adds a query helper with an injection.",
          risks: [{ area: "Security", rating: "high", reason: "raw SQL | interpolation" }],
          findingNotes: [{ id: 1, impact: "Any row readable.", steelman: "ids may be numeric.", confidence: "confirmed" }],
          traced: ["q() callers pass req.query.id"],
          notVerified: [{ item: "DB driver escaping", how: "check run() source" }],
        },
      });
      const result = await runReviewPipeline(deps({ llm, github: gh.port, settings: on() }));

      expect(result).toMatchObject({ status: "completed", verdict: "BLOCK", commentsPosted: 1 });
      const review = gh.reviews[0]!;
      expect(review.event).toBe("REQUEST_CHANGES");
      expect(review.body).toContain("⛔ BLOCK");
      expect(review.body).toContain("the reviewer model suggested APPROVE");
      expect(review.body).toContain("| Security | **High** | raw SQL \\| interpolation |");
      expect(review.body).toContain("**Steelman:** ids may be numeric.");
      expect(review.body).toContain("Confirmed by tracing");
      expect(review.body).toContain("| DB driver escaping | check run() source |");
      // Always admits nothing was run.
      expect(review.body).toContain("Nothing was built, run, or tested");
      expect(review.comments[0]!.body).toContain("**Impact:** Any row readable.");
      expect(gh.dismissals).toEqual([]);
    });

    it("drops a finding the principal disproves with a reason, approves, and clears old change requests", async () => {
      const gh = fakeGitHub();
      const llm = fakeLlm({
        principal: { action: "final", findingNotes: [{ id: 1, dismiss: true, dismissReason: "id is parsed as int upstream" }] },
      });
      const result = await runReviewPipeline(deps({ llm, github: gh.port, settings: on() }));
      expect(result).toMatchObject({ verdict: "APPROVE", commentsPosted: 0 });
      expect(gh.reviews[0]!.event).toBe("COMMENT");
      expect(gh.reviews[0]!.body).toContain("~~SQL injection via id~~");
      expect(gh.dismissals).toHaveLength(1);
    });

    it("ignores a dismissal without a reason", async () => {
      const llm = fakeLlm({ principal: { action: "final", findingNotes: [{ id: 1, dismiss: true }] } });
      expect(await runReviewPipeline(deps({ llm, settings: on() }))).toMatchObject({ verdict: "BLOCK" });
    });

    it("keeps outside-diff findings only for files it actually opened, and caps 'possible' below critical", async () => {
      const outsideFinding = (path: string) => ({
        path,
        line: 20,
        severity: "critical",
        category: "shutdown",
        title: `no drain in ${path}`,
        body: "b",
        confidence: 0.9,
        confidenceLabel: "possible",
      });
      const gh = fakeGitHub();
      const llm = fakeLlm({
        judge: { verdicts: [{ id: 1, keep: false, score: 0 }] },
        principal: [
          { action: "read_file", path: "src/main.ts" },
          { action: "final", additionalFindings: [outsideFinding("src/main.ts"), outsideFinding("src/never-opened.ts")] },
        ],
      });
      const result = await runReviewPipeline(deps({ llm, github: gh.port, settings: on() }));
      const body = gh.reviews[0]!.body;
      expect(body).toContain("no drain in src/main.ts");
      expect(body).not.toContain("never-opened");
      // "possible" can't block: critical is capped to major, so the verdict is REQUEST_CHANGES.
      expect(result).toMatchObject({ verdict: "REQUEST_CHANGES" });
      expect(body).toContain("🟠 Major: no drain in src/main.ts");
      expect(body).toContain("`read_file` `src/main.ts`");
    });

    it("counts findings hidden by minSeverity toward the verdict", async () => {
      const gh = fakeGitHub();
      const result = await runReviewPipeline(deps({ github: gh.port, settings: on({ minSeverity: "nit", maxComments: 1 }) }));
      expect(result).toMatchObject({ verdict: "BLOCK" });
    });

    it("never requests changes on a partial review", async () => {
      const gh = fakeGitHub();
      const llm = fakeLlm({ fail: /focus: correctness/ });
      await runReviewPipeline(deps({ llm, github: gh.port, settings: on({ reviewers: ["security", "bugs"] }) }));
      expect(gh.reviews[0]!.event).toBe("COMMENT");
      expect(gh.reviews[0]!.body).toContain("Partial review");
      expect(gh.dismissals).toEqual([]);
    });

    it("respects requestChanges: false", async () => {
      const gh = fakeGitHub();
      await runReviewPipeline(deps({ github: gh.port, settings: on({ requestChanges: false }) }));
      expect(gh.reviews[0]!.event).toBe("COMMENT");
      expect(gh.reviews[0]!.body).toContain("⛔ BLOCK");
    });

    it("falls back to a COMMENT review when GitHub rejects REQUEST_CHANGES", async () => {
      const posted: Parameters<GitHubPort["createReview"]>[0][] = [];
      const gh = fakeGitHub({
        createReview: async (review) => {
          if (review.event === "REQUEST_CHANGES") throw Object.assign(new Error("Can not request changes on your own pull request"), { status: 422 });
          posted.push(review);
        },
      });
      await runReviewPipeline(deps({ github: gh.port, settings: on() }));
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ event: "COMMENT", comments: [] });
      expect(posted[0]!.body).toContain("SQL injection via id");
    });

    it("publishes the specialist review if the principal fails on both models", async () => {
      const gh = fakeGitHub();
      const llm = fakeLlm({ fail: /principal reviewer/ });
      const result = await runReviewPipeline(deps({ llm, github: gh.port, settings: on() }));
      expect(result).toMatchObject({ status: "completed", commentsPosted: 1 });
      expect(result).not.toHaveProperty("verdict");
      expect(gh.reviews[0]!.event).toBe("COMMENT");
    });

    it("quick depth skips the principal pass", async () => {
      const llm = fakeLlm();
      const d = { ...deps({ llm, settings: on({ depth: "quick" }) }), createWorkspace: noWorkspace };
      await runReviewPipeline(d);
      expect(llm.calls.some((c) => c.messages[0]!.content.includes("principal reviewer"))).toBe(false);
    });
  });

  describe("repository guidelines", () => {
    it("loads guideline files from the base commit and gives them to reviewers and the principal", async () => {
      const gh = fakeGitHub({}, {
        "AGENTS.md": "Always use parameterized queries.",
        ".kiro/steering/behavioral-guidelines.md": "Surgical changes only.",
        ".kiro/steering/image.png": "binary",
      });
      const llm = fakeLlm();
      await runReviewPipeline(deps({ llm, github: gh.port, settings: settings({ principalReview: true }) }));

      expect(gh.reads.every((r) => r.ref === OLD)).toBe(true);
      const systems = llm.calls.map((c) => c.messages[0]!.content);
      const reviewer = systems.find((s) => s.includes("Your focus"))!;
      const principal = systems.find((s) => s.includes("principal reviewer"))!;
      for (const s of [reviewer, principal]) {
        expect(s).toContain("Always use parameterized queries.");
        expect(s).toContain("Surgical changes only.");
      }
      expect(gh.reads.some((r) => r.path.endsWith(".png"))).toBe(false);
      expect(gh.reviews[0]!.body).toContain("Repository guideline: `AGENTS.md`");
    });

    it("skips guidelines when disabled", async () => {
      const gh = fakeGitHub({}, { "AGENTS.md": "x" });
      await runReviewPipeline(deps({ github: gh.port, settings: settings({ useRepoGuidelines: false }) }));
      expect(gh.reads).toEqual([]);
    });
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
