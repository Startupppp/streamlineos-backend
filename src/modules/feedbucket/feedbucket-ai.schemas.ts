import { z } from "zod";

export const FeedbackAnalysisSchema = z.object({
  type: z.enum(["bug", "feature", "improvement", "question", "praise", "other"]),
  confidence: z.number().int().min(0).max(100),
  suggestedTicketType: z.enum(["EPIC", "BUG", "STORY", "TASK"]),
  title: z.string().max(255),
  summary: z.string().max(500),
  description: z.string(),
  reproductionSteps: z.array(z.string()),
  suggestions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  model: z.string(),
  processedAt: z.string(),
});

export type FeedbackAnalysis = z.infer<typeof FeedbackAnalysisSchema>;

export const analyzeBodySchema = z.object({
  force: z.boolean().optional(),
});

export type AnalyzeBodyInput = z.infer<typeof analyzeBodySchema>;
