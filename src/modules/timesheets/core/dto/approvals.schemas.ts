import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const approvalsQuerySchema = z.object({
  status: z.enum(["SUBMITTED", "APPROVED", "REJECTED"]).default("SUBMITTED"),
  userId: z.string().optional(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
});
export type ApprovalsQuery = z.infer<typeof approvalsQuerySchema>;

export const bulkApproveSchema = z.object({
  periodIds: z.array(z.number().int().positive()).min(1).max(100),
});
export type BulkApproveInput = z.infer<typeof bulkApproveSchema>;

export const bulkRejectSchema = z.object({
  periodIds: z.array(z.number().int().positive()).min(1).max(100),
  reason: z.string().min(1).max(500),
});
export type BulkRejectInput = z.infer<typeof bulkRejectSchema>;

export const rejectPeriodSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RejectPeriodInput = z.infer<typeof rejectPeriodSchema>;
