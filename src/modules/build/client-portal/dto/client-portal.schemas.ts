import { z } from "zod";

export const createPortalCrSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  impact: z.string().optional(),
  estimateMinutes: z.number().int().nonnegative().optional(),
  budgetImpactCents: z.number().int().optional(),
  timelineImpactDays: z.number().int().optional(),
}).strict();

export const toggleVisibilitySchema = z.object({
  clientVisible: z.boolean(),
}).strict();

export type CreatePortalCrInput = z.infer<typeof createPortalCrSchema>;
export type ToggleVisibilityInput = z.infer<typeof toggleVisibilitySchema>;
