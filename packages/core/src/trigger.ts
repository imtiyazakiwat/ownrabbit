import type { RepoSettings } from "./settings";

export type ReviewMode = "full" | "incremental";

export type Decision =
  | { review: true; mode: ReviewMode; reason: string; instructions?: string }
  | { review: false; reason: string };

export interface PullRequestInfo {
  draft?: boolean;
  state: string;
  user: { type: string } | null;
}

const OPEN_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);

export function decideForPullRequest(
  action: string,
  pr: PullRequestInfo,
  settings: RepoSettings,
): Decision {
  if (!settings.enabled) return { review: false, reason: "disabled" };
  if (settings.trigger === "mention") return { review: false, reason: "mention-only" };
  if (pr.state !== "open") return { review: false, reason: "not-open" };
  if (pr.draft && !settings.reviewDrafts) return { review: false, reason: "draft" };
  if (settings.skipBotPRs && pr.user?.type === "Bot") return { review: false, reason: "bot-pr" };

  if (OPEN_ACTIONS.has(action)) return { review: true, mode: "full", reason: action };
  if (action === "synchronize") return { review: true, mode: "incremental", reason: action };
  return { review: false, reason: `ignored-action:${action}` };
}

export interface MentionResult {
  matched: boolean;
  mode: ReviewMode;
  instructions?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find a bot mention in a comment. Quoted lines ("> ...") are ignored so that
 * replies quoting an earlier mention don't re-trigger a review.
 *
 *   @bot / @bot review        -> incremental
 *   @bot full review          -> full
 *   @bot <anything else>      -> full, with the text as reviewer instructions
 */
export function parseMention(body: string, mention: string): MentionResult {
  const handle = mention.replace(/^@/, "");
  const pattern = new RegExp(`(?:^|\\s)@${escapeRegex(handle)}(?:\\[bot\\])?(?![\\w-])(.*)$`, "i");

  for (const line of body.split(/\r?\n/)) {
    if (line.trimStart().startsWith(">")) continue;
    const match = pattern.exec(line);
    if (!match) continue;

    const rest = (match[1] ?? "").trim();
    if (rest === "" || /^review\b\.?$/i.test(rest)) return { matched: true, mode: "incremental" };
    if (/^full\s+review\b/i.test(rest)) {
      const extra = rest.replace(/^full\s+review\b/i, "").trim();
      return { matched: true, mode: "full", instructions: extra || undefined };
    }
    return { matched: true, mode: "full", instructions: rest.slice(0, 2000) };
  }
  return { matched: false, mode: "incremental" };
}

/** Only people with a real stake in the repo can spend review budget via mentions. */
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function decideForComment(args: {
  body: string;
  commenterType: string;
  authorAssociation: string;
  isPullRequest: boolean;
  mention: string;
  settings: RepoSettings;
}): Decision {
  const { body, commenterType, authorAssociation, isPullRequest, mention, settings } = args;
  if (!isPullRequest) return { review: false, reason: "not-a-pr" };
  // Never react to bots (including ourselves) to avoid feedback loops.
  if (commenterType === "Bot") return { review: false, reason: "bot-comment" };
  if (!TRUSTED_ASSOCIATIONS.has(authorAssociation)) return { review: false, reason: "untrusted-commenter" };
  if (!settings.enabled) return { review: false, reason: "disabled" };
  if (settings.trigger === "auto") return { review: false, reason: "auto-only" };

  const result = parseMention(body, mention);
  if (!result.matched) return { review: false, reason: "no-mention" };
  return { review: true, mode: result.mode, reason: "mention", instructions: result.instructions };
}
