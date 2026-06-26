import { z } from "zod";

const LEAD_STATUSES = ["NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "CONVERTED", "LOST"] as const;
const LEAD_PRIORITIES = ["HOT", "WARM", "COLD"] as const;

export const analyticsQuerySchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export const followUpsQuerySchema = z.object({
  overdue: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
});

export const checkDuplicatesQuerySchema = z.object({
  email: z.string().optional(),
  phone: z.string().optional(),
});

export const exportQuerySchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  assigneeId: z.string().optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type FollowUpsQuery = z.infer<typeof followUpsQuerySchema>;
export type CheckDuplicatesQuery = z.infer<typeof checkDuplicatesQuerySchema>;
export type ExportQuery = z.infer<typeof exportQuerySchema>;
