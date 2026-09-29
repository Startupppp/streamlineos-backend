import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const visibilitySummaryQuerySchema = z.object({
  ticketCursor: z.string().optional(),
  milestoneCursor: z.string().optional(),
  limit: pageSizeField(50),
}).strict();
export type VisibilitySummaryQuery = z.infer<typeof visibilitySummaryQuerySchema>;

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
  version: z.number().int().positive().optional(),
}).strict();

export type CreatePortalCrInput = z.infer<typeof createPortalCrSchema>;
export type ToggleVisibilityInput = z.infer<typeof toggleVisibilitySchema>;
