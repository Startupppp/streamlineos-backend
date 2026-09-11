import { z } from "zod";

/**
 * NEO-11 - what is standing here that is not ours.
 *
 * Raw SQL, so the keys are the column names rather than the camelCase the rest
 * of the module returns. `on_hand` is cast to text in the query for the reason
 * every quantity here is a string: a decimal(18,4) rounded through a JavaScript
 * number is a stock figure that no longer adds up.
 */
export const listConsignedResponseSchema = z.array(
  z.object({
    product_variant_id: z.number().int(),
    location_id: z.number().int(),
    ownership: z.string(),
    on_hand: z.string(),
  }),
);

/**
 * Taking title. `transactionIds` is both movements the conversion posted — the
 * issue against the old owner and the receipt against the new — because the
 * ledger is append-only and those two rows are the whole of the evidence.
 */
export const convertOwnershipResponseSchema = z.object({
  productVariantId: z.number().int(),
  locationId: z.number().int(),
  quantity: z.string(),
  fromOwnership: z.string(),
  toOwnership: z.string(),
  transactionIds: z.array(z.number().int()),
});
