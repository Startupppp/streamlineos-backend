import { z } from "zod";
import { timesheetBillingTypeSchema } from "./status.schemas";

const effectiveRangeValid = (v: {
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}) => !v.effectiveFrom || !v.effectiveTo || v.effectiveFrom <= v.effectiveTo;

const rateFields = z.object({
  projectId: z.number().int().positive().optional(),
  userId: z.string().optional(),
  taskId: z.number().int().positive().optional(),
  clientId: z.number().int().positive().optional(),
  billingType: timesheetBillingTypeSchema.optional(),
  billRate: z.number().positive(),
  costRate: z.number().positive().optional(),
  currency: z.string().max(3).optional(),
  priority: z.number().int().min(0).optional(),
  rateCardId: z.number().int().positive().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

export const createRateSchema = rateFields.refine(effectiveRangeValid, {
  message: "effectiveFrom must be on or before effectiveTo",
});
export type CreateRateInput = z.infer<typeof createRateSchema>;

export const updateRateSchema = rateFields.partial().refine(effectiveRangeValid, {
  message: "effectiveFrom must be on or before effectiveTo",
});
export type UpdateRateInput = z.infer<typeof updateRateSchema>;
