import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * D5 — the grain a valuation figure is quoted at.
 *
 * A valuation with no date is a valuation of "now", which is unquotable: the
 * number moves while it is being read and can never be reproduced. Either an
 * explicit `asOfDate` or a `periodId` pins it; a period resolves to its own
 * `end_date`, so the two are the same grain expressed two ways and the response
 * always names the date it answered for.
 */
const valuationGrain = {
  asOfDate: isoDate.optional(),
  periodId: z.coerce.number().int().positive().optional(),
};

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

export const valuationSummarySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    categoryId: z.coerce.number().int().positive().optional(),
    ...valuationGrain,
    ...pagination,
  })
  .strict();
export type ValuationSummaryInput = z.infer<typeof valuationSummarySchema>;

export const valuationLayersSchema = z
  .object({
    variantId: z.coerce.number().int().positive(),
    warehouseId: z.coerce.number().int().positive().optional(),
    ...valuationGrain,
    ...pagination,
  })
  .strict();
export type ValuationLayersInput = z.infer<typeof valuationLayersSchema>;

/**
 * The evidence behind a consumed quantity: which layer each issue drew from, how
 * much it took and at what unit cost. Filterable by layer, by movement or by
 * variant so a single valuation figure can be walked back to its lines.
 */
export const valuationConsumptionsSchema = z
  .object({
    variantId: z.coerce.number().int().positive().optional(),
    layerId: z.coerce.number().int().positive().optional(),
    stockTransactionId: z.coerce.number().int().positive().optional(),
    fromDate: isoDate.optional(),
    toDate: isoDate.optional(),
    periodId: z.coerce.number().int().positive().optional(),
    ...pagination,
  })
  .strict();
export type ValuationConsumptionsInput = z.infer<typeof valuationConsumptionsSchema>;
