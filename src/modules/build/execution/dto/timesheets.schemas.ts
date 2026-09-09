import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const timeEntryPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1, "Use cursor instead of page numbers").default(1),
  limit: pageSizeField(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const updateEntrySchema = z.object({
  hours: z.number().positive().optional(),
  description: z.string().optional(),
}).strict();

export const rejectEntrySchema = z.object({
  reason: z.string().optional(),
}).strict();

export const logTimeSchema = z.object({
  date: z.string(),
  hours: z.number().positive(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  workLink: z.string().optional(),
}).strict();

export const timeEntriesListQuerySchema = timeEntryPaginationQuerySchema.extend({
  userId: z.string().optional(),
  projectId: z.coerce.number().int().optional(),
  ticketId: z.coerce.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const teamTimesheetsQuerySchema = timeEntryPaginationQuerySchema.extend({
  userId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
});

export const billingSummaryQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;
export type TimeEntryPaginationQuery = z.infer<typeof timeEntryPaginationQuerySchema>;
export type RejectEntryInput = z.infer<typeof rejectEntrySchema>;
export type LogTimeInput = z.infer<typeof logTimeSchema>;
export type TimeEntriesListQuery = z.infer<typeof timeEntriesListQuerySchema>;
export type TeamTimesheetsQuery = z.infer<typeof teamTimesheetsQuerySchema>;
export type BillingSummaryQuery = z.infer<typeof billingSummaryQuerySchema>;
