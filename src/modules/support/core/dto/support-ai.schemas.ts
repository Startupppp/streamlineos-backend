import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const supportAiReportFiltersSchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: pageSizeField(50, 100),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export const updateSupportAiSettingsSchema = z.object({
  confidenceThreshold: z.number().min(0).max(1).optional(),
});

export const resolveAiSuggestionSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  feedback: z.enum(["helpful", "not_helpful"]).optional(),
});

export const translateMessageSchema = z.object({
  messageId: z.number().int().positive(),
  targetLanguage: z.string().trim().min(2).max(50),
});

export const supportReportFiltersSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  agentId: z.string().trim().optional(),
  queueId: z.coerce.number().int().positive().optional(),
  channel: z.string().trim().optional(),
});

export type SupportAiReportFiltersInput = z.infer<typeof supportAiReportFiltersSchema>;
export type UpdateSupportAiSettingsInput = z.infer<typeof updateSupportAiSettingsSchema>;
export type ResolveAiSuggestionInput = z.infer<typeof resolveAiSuggestionSchema>;
export type TranslateMessageInput = z.infer<typeof translateMessageSchema>;
export type SupportReportFiltersInput = z.infer<typeof supportReportFiltersSchema>;
