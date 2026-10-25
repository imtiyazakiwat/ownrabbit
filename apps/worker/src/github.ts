import type { Octokit } from "octokit";
import type { ChangedFile, GitHubPort, PullRequest } from "./orchestrator";
import { SUMMARY_MARKER } from "./publish";

const MAX_PR_FILES = 3000; // GitHub's hard cap for the list-files endpoint.

export function createGitHubPort(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  botLogin: string;
}): GitHubPort {
  const { octokit, owner, repo, prNumber, botLogin } = args;
  const base = { owner, repo };

  return {
    async getPullRequest(): Promise<PullRequest> {
      const { data } = await octokit.rest.pulls.get({ ...base, pull_number: prNumber });
      return {
        number: data.number,
        state: data.state,
        title: data.title,
        body: data.body ?? "",
        headSha: data.head.sha,
        baseSha: data.base.sha,
      };
    },

    async listPullRequestFiles(): Promise<ChangedFile[]> {
      const files: ChangedFile[] = [];
      for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
        ...base,
        pull_number: prNumber,
        per_page: 100,
      })) {
        for (const f of page.data) {
          files.push({
            filename: f.filename,
            status: f.status,
            patch: f.patch,
            additions: f.additions,
            deletions: f.deletions,
          });
        }
        if (files.length >= MAX_PR_FILES) break;
      }
      return files;
    },

    async compareFiles(baseSha: string, headSha: string): Promise<string[] | undefined> {
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
        ...base,
        basehead: `${baseSha}...${headSha}`,
        per_page: 100,
      });
      // "diverged"/"behind" means history was rewritten; incremental review is meaningless.
      if (data.status !== "ahead" && data.status !== "identical") return undefined;
      return (data.files ?? []).map((f) => f.filename);
    },

    async upsertSummaryComment(body: string, knownId?: number): Promise<number> {
      if (knownId) {
        try {
          await octokit.rest.issues.updateComment({ ...base, comment_id: knownId, body });
          return knownId;
        } catch (err) {
          if ((err as { status?: number }).status !== 404) throw err;
        }
      }
      // Fallback: locate our marker comment (state may have been lost).
      for await (const page of octokit.paginate.iterator(octokit.rest.issues.listComments, {
        ...base,
        issue_number: prNumber,
        per_page: 100,
      })) {
        const existing = page.data.find((c) => c.user?.login === botLogin && c.body?.includes(SUMMARY_MARKER));
        if (existing) {
          await octokit.rest.issues.updateComment({ ...base, comment_id: existing.id, body });
          return existing.id;
        }
      }
      const { data } = await octokit.rest.issues.createComment({ ...base, issue_number: prNumber, body });
      return data.id;
    },

    async createReview({ commitId, body, comments, event = "COMMENT" }) {
      await octokit.rest.pulls.createReview({
        ...base,
        pull_number: prNumber,
        commit_id: commitId,
        event,
        body,
        comments,
      });
    },

    async dismissStaleChangeRequests(message: string): Promise<number> {
      let dismissed = 0;
      for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listReviews, {
        ...base,
        pull_number: prNumber,
        per_page: 100,
      })) {
        for (const review of page.data) {
          if (review.state !== "CHANGES_REQUESTED" || review.user?.login !== botLogin) continue;
          await octokit.rest.pulls.dismissReview({ ...base, pull_number: prNumber, review_id: review.id, message });
          dismissed++;
        }
      }
      return dismissed;
    },

    async readFile(path: string, ref: string): Promise<string | undefined> {
      try {
        const { data } = await octokit.rest.repos.getContent({ ...base, path, ref });
        if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return undefined;
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (err) {
        if ((err as { status?: number }).status === 404) return undefined;
        throw err;
      }
    },

    async listDir(dir: string, ref: string): Promise<string[]> {
      try {
        const { data } = await octokit.rest.repos.getContent({ ...base, path: dir, ref });
        return Array.isArray(data) ? data.filter((e) => e.type === "file").map((e) => e.name) : [];
      } catch (err) {
        if ((err as { status?: number }).status === 404) return [];
        throw err;
      }
    },
  };
}
