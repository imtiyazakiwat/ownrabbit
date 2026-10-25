import { describe, expect, it } from "vitest";
import { defaultSettings, type RepoSettings } from "./settings";
import { decideForComment, decideForPullRequest, parseMention } from "./trigger";

const settings = (overrides: Partial<RepoSettings> = {}): RepoSettings => ({
  ...defaultSettings(),
  ...overrides,
});
const pr = { state: "open", draft: false, user: { type: "User" } };

describe("decideForPullRequest", () => {
  it("full review on open, incremental on push", () => {
    expect(decideForPullRequest("opened", pr, settings())).toMatchObject({ review: true, mode: "full" });
    expect(decideForPullRequest("synchronize", pr, settings())).toMatchObject({
      review: true,
      mode: "incremental",
    });
  });

  it("respects trigger, enabled, drafts and bots", () => {
    expect(decideForPullRequest("opened", pr, settings({ trigger: "mention" })).review).toBe(false);
    expect(decideForPullRequest("opened", pr, settings({ enabled: false })).review).toBe(false);
    expect(decideForPullRequest("opened", { ...pr, draft: true }, settings()).review).toBe(false);
    expect(
      decideForPullRequest("opened", { ...pr, draft: true }, settings({ reviewDrafts: true })).review,
    ).toBe(true);
    expect(decideForPullRequest("opened", { ...pr, user: { type: "Bot" } }, settings()).review).toBe(false);
    expect(decideForPullRequest("opened", { ...pr, user: null }, settings()).review).toBe(true);
    expect(decideForPullRequest("opened", { ...pr, state: "closed" }, settings()).review).toBe(false);
    expect(decideForPullRequest("labeled", pr, settings()).review).toBe(false);
  });
});

describe("parseMention", () => {
  const m = "@ownrabbit";

  it("handles bare, review, and full review", () => {
    expect(parseMention("@ownrabbit", m)).toEqual({ matched: true, mode: "incremental" });
    expect(parseMention("hey @ownrabbit review", m)).toEqual({ matched: true, mode: "incremental" });
    expect(parseMention("@OwnRabbit full review", m)).toMatchObject({ matched: true, mode: "full" });
    expect(parseMention("@ownrabbit[bot] review", m).matched).toBe(true);
  });

  it("treats other text as instructions", () => {
    expect(parseMention("@ownrabbit check auth flow", m)).toEqual({
      matched: true,
      mode: "full",
      instructions: "check auth flow",
    });
  });

  it("ignores lookalike handles, quotes, emails, and empty bodies", () => {
    expect(parseMention("@ownrabbit-dev review", m).matched).toBe(false);
    expect(parseMention("@ownrabbits", m).matched).toBe(false);
    expect(parseMention("> @ownrabbit review", m).matched).toBe(false);
    expect(parseMention("mail me at x@ownrabbit", m).matched).toBe(false);
    expect(parseMention("", m).matched).toBe(false);
  });

  it("caps instruction length", () => {
    const r = parseMention(`@ownrabbit ${"a".repeat(5000)}`, m);
    expect(r.instructions?.length).toBe(2000);
  });
});

describe("decideForComment", () => {
  const base = {
    body: "@ownrabbit review",
    commenterType: "User",
    authorAssociation: "OWNER",
    isPullRequest: true,
    mention: "@ownrabbit",
  };

  it("ignores mentions from people without a stake in the repo", () => {
    for (const authorAssociation of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", ""]) {
      expect(decideForComment({ ...base, authorAssociation, settings: settings() })).toEqual({
        review: false,
        reason: "untrusted-commenter",
      });
    }
    expect(decideForComment({ ...base, authorAssociation: "COLLABORATOR", settings: settings() }).review).toBe(true);
  });

  it("reviews on mention unless auto-only, bot, or not a PR", () => {
    expect(decideForComment({ ...base, settings: settings() }).review).toBe(true);
    expect(decideForComment({ ...base, settings: settings({ trigger: "auto" }) }).review).toBe(false);
    expect(decideForComment({ ...base, commenterType: "Bot", settings: settings() }).review).toBe(false);
    expect(decideForComment({ ...base, isPullRequest: false, settings: settings() }).review).toBe(false);
  });
});
