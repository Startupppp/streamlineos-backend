import { z } from "zod";

export const aiTextResponseSchema = z.object({
  text: z.string(),
  aiUsage: z.object({
    model: z.string(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cacheReadTokens: z.number().int().optional(),
    cacheWriteTokens: z.number().int().optional(),
    creditsCharged: z.number().optional(),
  }).optional(),
});

export const aiSummarizePeriodResponseSchema = z.object({
  narration: z.string(),
  evidence: z.record(z.string(), z.unknown()),
});
