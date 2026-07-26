import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const approvalsQuerySchema = z.object({
  status: z.enum(["SUBMITTED", "APPROVED", "REJECTED"]).default("SUBMITTED"),
  userId: z.string().optional(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
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
