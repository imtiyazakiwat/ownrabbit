import { RepoSettingsSchema } from "@ownrabbit/core";
import { z } from "zod";

/**
 * The context handed to the local MCP publisher. It contains no patches and no
 * GitHub token: the token is passed separately in the MCP server environment,
 * and the publisher fetches the diff itself.
 */
export const OpenCodeJobSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  mode: z.enum(["full", "incremental"]),
  files: z.array(z.string().min(1)).min(1),
  filesSkipped: z.number().int().min(0).default(0),
  /** True when the worker hit MAX_FILES and did not hand every reviewable file to the agent. */
  scopeTruncated: z.boolean().default(false),
  settings: RepoSettingsSchema,
  mention: z.string().min(1),
  botLogin: z.string().min(1),
  summaryCommentId: z.number().int().positive().optional(),
  guidelineFiles: z.array(z.string()).default([]),
});

export type OpenCodeJob = z.infer<typeof OpenCodeJobSchema>;

export const OpenCodeResultSchema = z.object({
  status: z.enum(["posted", "already-posted", "invalid", "failed"]),
  complete: z.boolean().default(false),
  commentsPosted: z.number().int().min(0).default(0),
  findingsRaw: z.number().int().min(0).default(0),
  findingsAnchored: z.number().int().min(0).default(0),
  findingsSelected: z.number().int().min(0).default(0),
  reviewedFiles: z.array(z.string()).default([]),
  skippedFiles: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
  summaryCommentId: z.number().int().positive().optional(),
  verdict: z.enum(["APPROVE", "APPROVE_WITH_COMMENTS", "REQUEST_CHANGES", "BLOCK"]).optional(),
  error: z.string().optional(),
  attempts: z.number().int().min(0).default(0),
});

export type OpenCodeResult = z.infer<typeof OpenCodeResultSchema>;

export const OPENCODE_RESULT_FILE = "review-result.json";
export const OPENCODE_CONFIG_FILE = "opencode.json";
