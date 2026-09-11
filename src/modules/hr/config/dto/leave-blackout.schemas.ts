import { z } from "zod";

export const blackoutListQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
}).strict();

export const createBlackoutSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().min(1).max(500),
  appliesTo: z.string().default("ALL"),
}).strict();

export type BlackoutListQuery = z.infer<typeof blackoutListQuerySchema>;
export type CreateBlackoutInput = z.infer<typeof createBlackoutSchema>;
