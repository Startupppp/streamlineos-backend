import { z } from "zod";

/**
 * D4 — what a recall is *about*, expressed once.
 *
 * A recall is rarely "these lot ids". It is "everything we made from that
 * batch of resin", "everything this supplier sent us in March", "this SKU
 * with a use-by date before the 14th" — and the operator raising it is
 * reading a defect report, not a lot table. The old UI asked for
 * comma-separated lot ids, which meant the operator had to do the resolution
 * in their head and the system had no record of what question they had asked.
 *
 * Every supplied criterion narrows: lot ids AND a variant AND a date range is
 * the intersection, not the union. That is the reading an operator expects
 * from a filter bar, and it is the only one that cannot silently widen a
 * recall.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateField = z.string().regex(ISO_DATE, "Expected an ISO date (YYYY-MM-DD)");

export const recallSelectionSchema = z
  .object({
    /** Explicit lots. Capped: the resolved set is the unit of work below. */
    lotIds: z.array(z.number().int().positive()).max(500).optional(),
    productVariantIds: z.array(z.number().int().positive()).max(200).optional(),
    /**
     * Attributed through the receipts that created the lots — `inv_lots` holds
     * a supplier lot *number* but no vendor, so the link is the posted GRN.
     */
    vendorId: z.number().int().positive().optional(),
    manufacturedFrom: dateField.optional(),
    manufacturedTo: dateField.optional(),
    expiryFrom: dateField.optional(),
    expiryTo: dateField.optional(),
  })
  .strict()
  .refine(
    (s) =>
      (s.lotIds?.length ?? 0) > 0 ||
      (s.productVariantIds?.length ?? 0) > 0 ||
      s.vendorId !== undefined,
    {
      message:
        "A recall selection needs at least one of lotIds, productVariantIds or vendorId",
    },
  )
  .refine(
    (s) =>
      s.manufacturedFrom === undefined ||
      s.manufacturedTo === undefined ||
      s.manufacturedFrom <= s.manufacturedTo,
    { message: "manufacturedFrom must not be after manufacturedTo", path: ["manufacturedTo"] },
  )
  .refine(
    (s) => s.expiryFrom === undefined || s.expiryTo === undefined || s.expiryFrom <= s.expiryTo,
    { message: "expiryFrom must not be after expiryTo", path: ["expiryTo"] },
  );

export type RecallSelectionInput = z.infer<typeof recallSelectionSchema>;

/**
 * The simulate body. No idempotency key: this endpoint writes nothing, so
 * there is nothing to replay — a POST purely because a selection does not fit
 * in a query string.
 */
export const simulateRecallSchema = z
  .object({ selection: recallSelectionSchema })
  .strict();

export type SimulateRecallInput = z.infer<typeof simulateRecallSchema>;
