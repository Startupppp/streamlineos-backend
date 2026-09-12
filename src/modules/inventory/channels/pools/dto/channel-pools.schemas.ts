import { z } from "zod";

/**
 * NEO-1. A quantity is a decimal string end to end — the ledger holds
 * `numeric(18,4)` and `decimal.ts` does the arithmetic, so a number here would
 * be a float round-trip on the one value that must not have one.
 */
const qtyString = z
  .string()
  .regex(/^-?\d{1,14}(\.\d{1,4})?$/, "Quantity must be a decimal with up to 4 places");

export const allocateChannelPoolSchema = z
  .object({
    channelId: z.number().int().positive(),
    productVariantId: z.number().int().positive(),
    /** Absent or null pins the claim to no warehouse: an organisation-wide pool. */
    warehouseId: z.number().int().positive().nullable().optional(),
    /** Signed: positive claims stock for the channel, negative gives it back. */
    deltaQty: qtyString.refine((v) => Number(v) !== 0, "A zero allocation changes nothing"),
  })
  .strict();

export const channelPoolAvailabilityQuerySchema = z
  .object({
    productVariantId: z.coerce.number().int().positive(),
    warehouseId: z.coerce.number().int().positive().optional(),
    forChannelId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export const variantChannelPoolsQuerySchema = z
  .object({
    productVariantId: z.coerce.number().int().positive(),
    warehouseId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export type AllocateChannelPoolInput = z.infer<typeof allocateChannelPoolSchema>;
export type ChannelPoolAvailabilityQuery = z.infer<typeof channelPoolAvailabilityQuerySchema>;
export type VariantChannelPoolsQuery = z.infer<typeof variantChannelPoolsQuerySchema>;
