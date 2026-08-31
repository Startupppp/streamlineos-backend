import { z } from "zod";
import { optionalPageSizeField } from "../../../common/pagination/list-query.schema";

export const analyticsQuerySchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export const followUpsQuerySchema = z.object({
  overdue: z.enum(["true", "false"]).optional(),
  limit: optionalPageSizeField(50),
});

export const checkDuplicatesQuerySchema = z.object({
  email: z.string().optional(),
  phone: z.string().optional(),
});

export const exportQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  assigneeId: z.string().optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type FollowUpsQuery = z.infer<typeof followUpsQuerySchema>;
export type CheckDuplicatesQuery = z.infer<typeof checkDuplicatesQuerySchema>;
export type ExportQuery = z.infer<typeof exportQuerySchema>;
