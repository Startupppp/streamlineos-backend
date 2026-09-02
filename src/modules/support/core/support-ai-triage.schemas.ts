import { z } from "zod";

export const analysisSchema = z.object({
  summary: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  category: z.string().nullable(),
  suggestedPriority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  isSpam: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export const macroPickSchema = z.object({
  macroId: z.number().int().nullable(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});

export const handoffSummarySchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()).max(6),
  suggestedNextStep: z.string(),
});

export const rootCauseSchema = z.object({
  rootCause: z.string(),
  summary: z.string(),
});
