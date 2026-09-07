import { z } from "zod";

/**
 * `GET /support/ai/report` returns one aggregate metrics object — acceptance,
 * resolution, reopen and escalation rates computed with `count(*) filter (…)`
 * over the whole matching set. There is no row list, so there was never anything
 * to page: `SupportAiReportHelper.getAiReport` reads only `dateFrom`/`dateTo`,
 * and `cursor`/`limit` reached the type declaration and nothing else. Advertising
 * them made the route look paginated to `check:envelope-consistency` and made a
 * client's cursor silently disappear. The only caller never sent either.
 */
export const supportAiReportFiltersSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
}).strict();

export const updateSupportAiSettingsSchema = z.object({
  confidenceThreshold: z.number().min(0).max(1).optional(),
}).strict();

export const resolveAiSuggestionSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  feedback: z.enum(["helpful", "not_helpful"]).optional(),
}).strict();

export const translateMessageSchema = z.object({
  messageId: z.number().int().positive(),
  targetLanguage: z.string().trim().min(2).max(50),
}).strict();

export const supportReportFiltersSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  agentId: z.string().trim().optional(),
  queueId: z.coerce.number().int().positive().optional(),
  channel: z.string().trim().optional(),
}).strict();

export type SupportAiReportFiltersInput = z.infer<typeof supportAiReportFiltersSchema>;
export type UpdateSupportAiSettingsInput = z.infer<typeof updateSupportAiSettingsSchema>;
export type ResolveAiSuggestionInput = z.infer<typeof resolveAiSuggestionSchema>;
export type TranslateMessageInput = z.infer<typeof translateMessageSchema>;
export type SupportReportFiltersInput = z.infer<typeof supportReportFiltersSchema>;
