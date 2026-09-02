import { z } from "zod";

export const submitChangeRequestSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  impact: z.string().optional(),
  estimateMinutes: z.number().int().nonnegative().optional(),
  budgetImpactCents: z.number().int().optional(),
  timelineImpactDays: z.number().int().optional(),
}).strict();

export type SubmitChangeRequestInput = z.infer<typeof submitChangeRequestSchema>;
