import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const listRulesSchema = z.object({
  variantId: z.coerce.number().int().positive().optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  active: queryBoolean.optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
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
  .strict()
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
  .strict()
  .refine((d) => d.maxQty == null || d.minQty == null || d.maxQty >= d.minQty, minMaxMessage);
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

/**
 * C2 — a client-sent quantity is dropped at the boundary, not read and ignored.
 *
 * The field is still *accepted*, because a caller sending one is not doing
 * anything wrong and a 400 would break every client that learned the old shape.
 * It is simply not the authority, and "not the authority" is enforced by making
 * it absent from the parsed value rather than by the service remembering never
 * to look: the transform below drops it, so `GeneratePoInput` has no
 * `suggestedQty` at all and no future edit to the service can reintroduce a
 * dependency on one. That is the difference between a rule and a convention.
 *
 * `unitCost` survives because it is not a quantity. What an organisation agrees
 * to pay is a commercial decision a buyer makes; how much of a thing it needs is
 * arithmetic the ledger owns.
 */
const generatePoLineSchema = z
  .object({
    productVariantId: z.number().int().positive(),
    suggestedQty: z.number().positive().optional(),
    unitCost: z.number().min(0).optional(),
  })
  .strict()
  .transform(({ productVariantId, unitCost }) => ({ productVariantId, unitCost }));

export const generatePoSchema = z.object({
  vendorId: z.number().int().positive(),
  warehouseId: z.number().int().positive().optional(),
  suggestions: z.array(generatePoLineSchema).min(1),
}).strict();
export type GeneratePoInput = z.infer<typeof generatePoSchema>;

export const suggestionsQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type SuggestionsQueryInput = z.infer<typeof suggestionsQuerySchema>;

export const forecastingSchema = z.object({
  variantId: z.coerce.number().int().positive().optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ForecastingInput = z.infer<typeof forecastingSchema>;
