import { z } from "zod";

export const aiUsageResponseSchema = z.object({
  totals: z.object({
    totalTokens: z.number(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    estimatedCostUsd: z.string(),
    requestCount: z.number().int(),
  }),
  byFeature: z.array(z.object({
    feature: z.string(),
    model: z.string(),
    totalTokens: z.number(),
    estimatedCostUsd: z.string(),
    requestCount: z.number().int(),
  })),
  daily: z.array(z.object({
    date: z.string(),
    totalTokens: z.number(),
    estimatedCostUsd: z.string(),
    requestCount: z.number().int(),
  })),
  performance: z.object({
    avgLatencyMs: z.number().nullable(),
    p95LatencyMs: z.number().nullable(),
    errorRate: z.number(),
  }),
  acceptance: z.object({
    feedbackByFeature: z.array(z.object({
      feature: z.string(),
      up: z.number().int(),
      down: z.number().int(),
      total: z.number().int(),
      ratio: z.number().nullable(),
    })),
    supportSuggestions: z.object({
      accepted: z.number().int(),
      rejected: z.number().int(),
      pending: z.number().int(),
    }),
  }),
});

export const blogImproveWritingResponseSchema = z.object({ content: z.string() });
export const blogSuggestTitleResponseSchema = z.object({ title: z.string() });
export const blogSummarizeResponseSchema = z.object({ excerpt: z.string() });

export const surveyAiSummarizeResponseSchema = z.object({ summary: z.string() });
