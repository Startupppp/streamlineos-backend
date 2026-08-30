import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const updateEntrySchema = z.object({
  hours: z.number().positive().optional(),
  description: z.string().optional(),
});

export const rejectEntrySchema = z.object({
  reason: z.string().optional(),
});

export const logTimeSchema = z.object({
  date: z.string(),
  hours: z.number().positive(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  workLink: z.string().optional(),
});

export const timeEntriesListQuerySchema = z.object({
  userId: z.string().optional(),
  projectId: z.coerce.number().int().optional(),
  ticketId: z.coerce.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50),
});

export const teamTimesheetsQuerySchema = z.object({
  userId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50),
});

export const billingSummaryQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;
export type RejectEntryInput = z.infer<typeof rejectEntrySchema>;
export type LogTimeInput = z.infer<typeof logTimeSchema>;
export type TimeEntriesListQuery = z.infer<typeof timeEntriesListQuerySchema>;
export type TeamTimesheetsQuery = z.infer<typeof teamTimesheetsQuerySchema>;
export type BillingSummaryQuery = z.infer<typeof billingSummaryQuerySchema>;
