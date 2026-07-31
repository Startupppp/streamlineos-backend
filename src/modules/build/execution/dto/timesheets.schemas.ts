import { z } from "zod";

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
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const teamTimesheetsQuerySchema = z.object({
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
export type RejectEntryInput = z.infer<typeof rejectEntrySchema>;
export type LogTimeInput = z.infer<typeof logTimeSchema>;
export type TimeEntriesListQuery = z.infer<typeof timeEntriesListQuerySchema>;
export type TeamTimesheetsQuery = z.infer<typeof teamTimesheetsQuerySchema>;
export type BillingSummaryQuery = z.infer<typeof billingSummaryQuerySchema>;
