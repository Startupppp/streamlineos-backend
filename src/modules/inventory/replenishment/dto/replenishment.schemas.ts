import { z } from "zod";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const listRulesSchema = z.object({
  variantId: z.coerce.number().int().positive().optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  active: queryBoolean.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListRulesInput = z.infer<typeof listRulesSchema>;

const minMaxRefinement = (data: { minQty: number; maxQty?: number }) =>
  data.maxQty == null || data.maxQty >= data.minQty;
const minMaxMessage = { message: "maxQty must be >= minQty" };

export const createRuleSchema = z
  .object({
    productVariantId: z.number().int().positive(),
    warehouseId: z.number().int().positive().optional(),
    minQty: z.number().min(0),
    maxQty: z.number().min(0).optional(),
    reorderQty: z.number().min(0).optional(),
    vendorId: z.number().int().positive().optional(),
    leadTimeDays: z.number().int().min(0).optional(),
    safetyStock: z.number().min(0).optional(),
  })
  .refine(minMaxRefinement, minMaxMessage);
export type CreateRuleInput = z.infer<typeof createRuleSchema>;

export const updateRuleSchema = z
  .object({
    minQty: z.number().min(0).optional(),
    maxQty: z.number().min(0).optional(),
    reorderQty: z.number().min(0).optional(),
    vendorId: z.number().int().positive().nullable().optional(),
    leadTimeDays: z.number().int().min(0).optional(),
    safetyStock: z.number().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => d.maxQty == null || d.minQty == null || d.maxQty >= d.minQty, minMaxMessage);
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

export const generatePoSchema = z.object({
  vendorId: z.number().int().positive(),
  warehouseId: z.number().int().positive().optional(),
  suggestions: z.array(
    z.object({
      productVariantId: z.number().int().positive(),
      suggestedQty: z.number().positive(),
      unitCost: z.number().min(0).optional(),
    }),
  ).min(1),
});
export type GeneratePoInput = z.infer<typeof generatePoSchema>;

export const suggestionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SuggestionsQueryInput = z.infer<typeof suggestionsQuerySchema>;

export const forecastingSchema = z.object({
  variantId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ForecastingInput = z.infer<typeof forecastingSchema>;
