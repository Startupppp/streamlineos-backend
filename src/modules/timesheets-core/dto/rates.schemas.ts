import { z } from "zod";

export const createRateSchema = z.object({
  projectId: z.number().int().positive().optional(),
  userId: z.string().optional(),
  taskId: z.number().int().positive().optional(),
  clientId: z.number().int().positive().optional(),
  billingType: z.string().optional(),
  billRate: z.number().positive(),
  costRate: z.number().positive().optional(),
  currency: z.string().max(3).optional(),
  priority: z.number().int().min(0).optional(),
  rateCardId: z.number().int().positive().optional(),
});
export type CreateRateInput = z.infer<typeof createRateSchema>;

export const updateRateSchema = createRateSchema.partial();
export type UpdateRateInput = z.infer<typeof updateRateSchema>;
