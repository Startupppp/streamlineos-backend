import { z } from "zod";

/**
 * INV-104/A2 — ledger-to-projection reconciliation on the wire.
 *
 * Every quantity is a decimal string: these are 18,4 numerics summed in SQL and
 * cast to text, and turning one into a JavaScript number is exactly the drift
 * the report exists to find.
 */
const driftRowSchema = z.object({
  check: z.string(),
  /** Null on an orphan check, where the drifting thing is the absence of a row. */
  stockLevelId: z.number().int().nullable(),
  productVariantId: z.number().int(),
  locationId: z.number().int().nullable(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  field: z.string(),
  projected: z.string(),
  expected: z.string(),
  difference: z.string(),
});

export const reconciliationReportResponseSchema = z.object({
  generatedAt: z.string(),
  scope: z.object({
    warehouseKey: z.string(),
    warehouseId: z.number().int().nullable(),
    productVariantId: z.number().int().nullable(),
  }),
  checked: z.array(z.string()),
  /** What the report still does not claim to check, stated rather than implied. */
  unreconcilable: z.array(z.string()),
  drift: z.array(driftRowSchema),
  driftCount: z.number().int(),
  truncated: z.boolean(),
});

/**
 * Dry run by default: without `apply` the answer carries the preview and changes
 * nothing, and with it the preview is null because the rebuild has already run.
 */
export const reconciliationRepairResponseSchema = z.object({
  applied: z.boolean(),
  rowsChanged: z.number().int(),
  preview: reconciliationReportResponseSchema.nullable(),
});
