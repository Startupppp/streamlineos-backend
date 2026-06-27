import { z } from "zod";

export const listWorkLogsQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number(),
  quarter: z.coerce.number(),
  month: z.coerce.number().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export const postWorkLogSchema = z.object({
  date: z.string(),
  hours: z.number().optional(),
  description: z.string().optional(),
  workLink: z.string().url().optional().or(z.literal("")),
});

export const exportWorkLogsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  userId: z.string().optional(),
});

export const patchWorkLogStatusSchema = z.object({
  id: z.number(),
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().optional(),
});

export type ListWorkLogsQuery = z.infer<typeof listWorkLogsQuerySchema>;
export type PostWorkLogInput = z.infer<typeof postWorkLogSchema>;
export type ExportWorkLogsQuery = z.infer<typeof exportWorkLogsQuerySchema>;
export type PatchWorkLogStatusInput = z.infer<typeof patchWorkLogStatusSchema>;
