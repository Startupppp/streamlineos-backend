import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const valuationLayerSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  productVariantId: z.number().int(),
  locationId: z.number().int().nullable(),
  lotId: z.number().int().nullable(),
  stockTransactionId: z.number().int().nullable(),
  quantity: z.string(),
  unitCost: z.string().optional(),
  totalValue: z.string().optional(),
  remainingQuantity: z.string(),
  remainingValue: z.string().optional(),
  costingMethod: z.string(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  createdAt: wireDate(),
});

export const valuationSummaryResponseSchema = z.object({
  items: z.array(z.object({
    productVariantId: z.number().int(),
    variantSku: z.string(),
    variantName: z.string(),
    productId: z.number().int(),
    productName: z.string(),
    costingMethod: z.string(),
    onHand: z.number(),
    value: z.number(),
    averageCost: z.number(),
  })),
  total: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
  totalValue: z.number(),
});

export const valuationLayersResponseSchema = z.object({
  items: z.array(valuationLayerSchema),
  total: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
});
