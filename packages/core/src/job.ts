import { z } from "zod";

export const ReviewJobSchema = z.object({
  /** GitHub delivery id; unique per webhook, used for idempotency. */
  jobId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  installationId: z.number().int().positive(),
  repoId: z.number().int().positive(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  /** Head SHA at trigger time. Auto reviews are dropped if the PR moved on. */
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  mode: z.enum(["full", "incremental"]),
  trigger: z.enum(["auto", "mention"]),
  instructions: z.string().max(2000).optional(),
  commentId: z.number().int().positive().optional(),
  requestedBy: z.string().optional(),
});

export type ReviewJob = z.infer<typeof ReviewJobSchema>;
