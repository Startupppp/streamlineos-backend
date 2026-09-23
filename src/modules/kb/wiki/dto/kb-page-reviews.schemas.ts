import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listPageReviewsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: pageSizeField(50),
    status: z.enum(["pending", "approved", "rejected", "overdue"]).optional(),
    type: z.enum(["approval", "freshness"]).optional(),
    reviewer: z.string().optional(),
    dueFrom: z.string().datetime().optional(),
    dueTo: z.string().datetime().optional(),
    spaceId: z.coerce.number().int().positive().optional(),
    sortDir: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
export type ListPageReviewsQuery = z.infer<typeof listPageReviewsQuerySchema>;

export const bulkDecidePageReviewsSchema = z.discriminatedUnion("decision", [
  z.object({
    ids: z.array(z.number().int().positive()).min(1).max(100),
    decision: z.literal("approved"),
    note: z.string().max(2000).optional(),
  }),
  z.object({
    ids: z.array(z.number().int().positive()).min(1).max(100),
    decision: z.literal("rejected"),
    note: z.string().min(1).max(2000),
  }),
]);
export type BulkDecidePageReviewsInput = z.infer<typeof bulkDecidePageReviewsSchema>;

export const createPageReviewSchema = z
  .object({
    type: z.enum(["approval", "freshness"]),
    reviewerId: z.string().optional(),
    dueAt: z.string().datetime().optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type CreatePageReviewInput = z.infer<typeof createPageReviewSchema>;

export const approveReviewSchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict();
export type ApproveReviewInput = z.infer<typeof approveReviewSchema>;

export const rejectReviewSchema = z
  .object({
    note: z.string().min(1).max(2000),
  })
  .strict();
export type RejectReviewInput = z.infer<typeof rejectReviewSchema>;
