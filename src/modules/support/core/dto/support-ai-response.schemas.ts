import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const supportAiSettingsSchema = z.object({
  confidenceThreshold: z.string(),
});

export const supportAiSuggestionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ticketId: z.number().int(),
  type: z.enum([
    "summary", "sentiment", "category", "priority", "spam",
    "reply", "macro", "kb_article", "duplicate", "handoff_summary", "root_cause_cluster",
  ]),
  payload: z.record(z.string(), z.unknown()),
  confidence: z.string().nullable(),
  status: z.enum(["pending", "accepted", "rejected"]),
  feedback: z.string().nullable(),
  resolvedAt: nullableWireDate(),
  resolvedBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const supportAiSuggestionListSchema = z.array(supportAiSuggestionRowSchema);

export const supportAiSuggestionNullableSchema = supportAiSuggestionRowSchema.nullable();

export const supportAiTranslationSchema = z.object({
  translatedText: z.string(),
  detectedSourceLanguage: z.string(),
}).nullable();

export const supportAiImproveReplySchema = z.object({
  improved: z.string(),
  changes: z.array(z.string()),
}).nullable();

export const supportAiReportSchema = z.object({
  acceptanceRate: z.number(),
  resolutionRate: z.number(),
  reopenRate: z.number(),
  escalationRate: z.number(),
  sourceCoverage: z.number(),
  unsupportedRate: z.number(),
  csatImpact: z.object({
    aiResolved: z.number().nullable(),
    nonAiResolved: z.number().nullable(),
  }).nullable(),
});
