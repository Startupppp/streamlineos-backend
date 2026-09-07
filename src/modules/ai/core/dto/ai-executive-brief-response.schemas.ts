import { z } from "zod";

const briefCitationSchema = z.object({
  id: z.string(),
  title: z.string(),
  href: z.string(),
});

const aiUsageMetaSchema = z.object({
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

const executiveBriefSnapshotSchema = z.object({
  narrative: z.string(),
  citations: z.array(briefCitationSchema),
  uncertaintyNotes: z.array(z.string()),
  generatedAt: z.string(),
  aiUsage: aiUsageMetaSchema.nullable(),
});

export const executiveBriefGetLatestResponseSchema = z.object({
  snapshot: executiveBriefSnapshotSchema.nullable(),
  isStale: z.boolean(),
  staleSinceMinutes: z.number().int().optional(),
});

export const executiveBriefGenerateResponseSchema = executiveBriefSnapshotSchema.extend({
  sources: z.record(z.string(), z.unknown()),
});
