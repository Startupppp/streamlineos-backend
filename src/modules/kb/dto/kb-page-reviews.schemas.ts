import { z } from "zod";

export const createPageReviewSchema = z.object({
  type: z.enum(["approval", "freshness"]),
  reviewerId: z.string().optional(),
  dueAt: z.string().datetime().optional(),
  note: z.string().max(2000).optional(),
});
export type CreatePageReviewInput = z.infer<typeof createPageReviewSchema>;

export const approveReviewSchema = z.object({
  note: z.string().max(2000).optional(),
});
export type ApproveReviewInput = z.infer<typeof approveReviewSchema>;

export const rejectReviewSchema = z.object({
  note: z.string().min(1).max(2000),
});
export type RejectReviewInput = z.infer<typeof rejectReviewSchema>;
