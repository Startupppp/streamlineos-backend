import { z } from "zod";

/**
 * G5 — the landed-cost boundary.
 *
 * Charges are integer minor units and nothing else. A decimal here would be a
 * float by the time Zod handed it over, and this is the one number on the
 * document that becomes both a debit and a credit in the general ledger — a
 * binary fraction in it is an unbalanced journal entry, not a rounding
 * curiosity. The valuation side of the module works in 4-decimal strings, and
 * the conversion between the two is exact.
 */
const chargeSchema = z
  .object({
    chargeType: z.enum(["FREIGHT", "DUTY", "INSURANCE", "HANDLING", "OTHER"]),
    description: z.string().trim().min(1).max(300),
    /**
     * Integer minor units, always positive. A credit note reduces what was paid
     * for the goods, which is the purchase order's business, not this document's.
     * `safe` caps it below 2^53 so the value survives JSON without silently
     * losing precision on the way in.
     */
    amountCents: z.number().int().positive().safe(),
    vendorId: z.number().int().positive().optional(),
    reference: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const createLandedCostVoucherSchema = z
  .object({
    grnId: z.number().int().positive(),
    /**
     * VALUE follows what each layer was worth, QUANTITY follows how many units
     * it holds. Duty is assessed on value and pallet handling is not, so there
     * is no default that is right for both and the caller states it.
     */
    allocationBasis: z.enum(["VALUE", "QUANTITY"]).default("VALUE"),
    currency: z.string().trim().length(3).toUpperCase().default("INR"),
    notes: z.string().trim().max(2000).optional(),
    charges: z.array(chargeSchema).min(1).max(50),
  })
  .strict();

export const addLandedCostChargeSchema = chargeSchema;

export const listLandedCostVouchersSchema = z
  .object({
    grnId: z.coerce.number().int().positive().optional(),
    status: z.enum(["DRAFT", "APPLIED"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    // The platform-wide hard cap. A page bigger than this is refused, never
    // silently clamped, so a client asking for 500 learns that it did.
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type CreateLandedCostVoucherInput = z.infer<typeof createLandedCostVoucherSchema>;
export type AddLandedCostChargeInput = z.infer<typeof addLandedCostChargeSchema>;
export type ListLandedCostVouchersInput = z.infer<typeof listLandedCostVouchersSchema>;
