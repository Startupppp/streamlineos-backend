import { z } from "zod";

export const listReviewsQuerySchema = z
  .object({
    status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
    type: z.enum(["approval", "freshness"]).optional(),
  })
  .strict();
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;

export const listDueReviewsQuerySchema = z
  .object({
    afterDueAt: z.string().datetime().optional(),
    afterId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((d) => (d.afterDueAt !== undefined) === (d.afterId !== undefined), {
    message: "afterDueAt and afterId must both be present or both absent",
  });
export type ListDueReviewsQuery = z.infer<typeof listDueReviewsQuerySchema>;

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
