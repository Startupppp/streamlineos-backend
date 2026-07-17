import { z } from "zod";

export const createFeedbackSchema = z.object({
  feature: z.string().min(1).max(100),
  rating: z.enum(["UP", "DOWN"]),
  correlationId: z.string().max(64).optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(50).optional(),
  reason: z.string().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type CreateFeedbackDto = z.infer<typeof createFeedbackSchema>;

export const feedbackSummaryQuerySchema = z.object({
  feature: z.string().max(100).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

export type FeedbackSummaryQuery = z.infer<typeof feedbackSummaryQuerySchema>;
