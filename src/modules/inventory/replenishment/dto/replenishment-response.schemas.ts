import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";
import { invPoSchema } from "../../purchase-orders/dto/purchase-orders-response.schemas";

export const invReorderRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  minQty: z.string(),
  maxQty: z.string().nullable(),
  reorderQty: z.string().nullable(),
  vendorId: z.number().int().nullable(),
  leadTimeDays: z.number().int().nullable(),
  safetyStock: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const ruleWithRelationsSchema = invReorderRuleSchema.extend({
  productVariant: z.object({
    id: z.number().int(),
    name: z.string(),
    sku: z.string(),
    product: z.object({ id: z.number().int(), name: z.string(), sku: z.string() }),
  }),
  warehouse: z.object({ id: z.number().int(), name: z.string() }).nullable(),
});

export const listRulesResponseSchema = itemsPagedSchema(ruleWithRelationsSchema);

export const ruleResponseSchema = invReorderRuleSchema;

const suggestionItemSchema = z.object({
  productVariantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productName: z.string(),
  ruleId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  warehouseName: z.string().nullable(),
  currentOnHand: z.number(),
  forecasted: z.number(),
  suggestedQty: z.number(),
  vendorId: z.number().int().nullable(),
  leadTimeDays: z.number().int(),
  expectedDate: z.string(),
  reason: z.string(),
});

export const listSuggestionsResponseSchema = itemsPagedSchema(suggestionItemSchema);

export { invPoSchema as generatePoResponseSchema };

const projectedWeekSchema = z.object({
  week: z.number().int(),
  projectedDemand: z.number(),
  projectedStock: z.number(),
});

const forecastItemSchema = z.object({
  variantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productName: z.string(),
  onHand: z.number(),
  onOrder: z.number(),
  avgWeeklyDemand: z.number(),
  weeksOfStock: z.number().nullable(),
  stockoutRisk: z.string(),
  projectedWeeks: z.array(projectedWeekSchema),
});

export const listForecastingResponseSchema = itemsPagedSchema(forecastItemSchema);
