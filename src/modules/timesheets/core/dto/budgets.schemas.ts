import { z } from "zod";

export const createBudgetSchema = z.object({
  projectId: z.number().int().optional(),
  clientId: z.number().int().optional(),
  budgetType: z.enum(["HOURS", "AMOUNT"]).optional(),
  budgetHours: z.number().nonnegative().optional(),
  budgetAmount: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  alertThresholds: z.array(z.number().min(0).max(200)).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});

export const updateBudgetSchema = createBudgetSchema.partial();

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;
