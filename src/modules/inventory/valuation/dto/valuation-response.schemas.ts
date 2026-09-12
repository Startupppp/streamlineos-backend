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

/**
 * D5 — which layers each issue drew from, and what the draw cost.
 *
 * Straight off `db.execute`, so the money and quantity columns are the `::text`
 * casts the projection asked for while `createdAt` and `layerCreatedAt` come
 * back as `Date` objects — postgres-js parses a timestamp OID before drizzle
 * sees the row.
 */
export const valuationConsumptionsResponseSchema = z.object({
  window: z.object({
    fromDate: z.string(),
    toDate: z.string(),
    period: z
      .object({
        periodId: z.string(),
        name: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        status: z.string(),
      })
      .nullable(),
  }),
  items: z.array(
    z.object({
      consumptionId: z.number().int(),
      createdAt: wireDate(),
      stockTransactionId: z.number().int(),
      valuationLayerId: z.number().int(),
      quantity: z.string(),
      unitCost: z.string(),
      totalCost: z.string(),
      layerUnitCost: z.string(),
      layerCreatedAt: wireDate(),
      layerSourceType: z.string().nullable(),
      layerSourceId: z.string().nullable(),
      costingMethod: z.string(),
      productVariantId: z.number().int(),
      transactionType: z.string(),
      referenceType: z.string().nullable(),
      referenceId: z.string().nullable(),
      postingDate: z.string(),
      variantSku: z.string(),
      productName: z.string(),
      locationName: z.string().nullable(),
    }),
  ),
  total: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
});

/**
 * The accounting periods a valuation may be quoted at. `installed` means "this
 * organisation keeps books" — the tables always exist, so an empty list with
 * `installed: false` is a tenant with no default book.
 */
export const listValuationPeriodsResponseSchema = z.object({
  installed: z.boolean(),
  items: z.array(
    z.object({
      periodId: z.string(),
      name: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      status: z.string(),
    }),
  ),
});
