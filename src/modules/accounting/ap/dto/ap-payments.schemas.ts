import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const currency = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 currency code");
const fxRate = z
  .string()
  .regex(/^\d+(\.\d{1,10})?$/, "Expected a positive decimal with at most 10 decimal places");

export const allocationSchema = z
  .object({
    documentId: z.string().min(1),
    amountMinor: z.number().int().positive(),
  })
  .strict();

/**
 * How much to withhold.
 *
 * `auto` runs the withholding engine against the vendor's code — the normal
 * path. `manual` states a rate or an amount outright, which is what a lower- or
 * nil-deduction certificate looks like in practice. `none` says explicitly that
 * nothing is withheld, so "we forgot" and "we decided not to" are different
 * records.
 */
export const withholdingInstructionSchema = z
  .object({
    mode: z.enum(["auto", "manual", "none"]).default("auto"),
    /** Overrides the vendor's own code. `194J`, `WHT_10`, a payment code. */
    code: z.string().trim().min(1).max(32).nullish(),
    /** `manual` only. 1000 = 10.00%. */
    rateBp: z.number().int().min(0).max(10_000).nullish(),
    /** `manual` only, and mutually exclusive with `rateBp`. */
    withheldMinor: z.number().int().min(0).nullish(),
    /**
     * What the deduction is computed on. Defaults to the tax-exclusive value of
     * what is being paid, because most regimes withhold on the net.
     */
    baseMinor: z.number().int().positive().nullish(),
    payeeType: z.enum(["company", "individual", "huf", "firm", "other"]).nullish(),
    taxIdOnFile: z.boolean().nullish(),
    /** Paid to this vendor under the same code so far this year. */
    cumulativeBaseMinor: z.number().int().min(0).nullish(),
    reason: z.string().trim().max(500).nullish(),
  })
  .strict()
  .refine((w) => !(w.rateBp != null && w.withheldMinor != null), {
    message: "Give a rate or an amount, not both",
    path: ["withheldMinor"],
  });

export const postApPaymentSchema = z
  .object({
    bookId: z.string().min(1).optional(),
    partyId: z.string().min(1),
    paymentDate: isoDate,
    /** The cash or bank GL account the money left. */
    paymentAccountId: z.string().min(1),
    currency: currency.optional(),
    fxRate: fxRate.optional(),
    /** Owed to the vendor before withholding. Defaults to the allocated total. */
    grossMinor: z.number().int().positive().optional(),
    withholding: withholdingInstructionSchema.optional(),
    allocations: z.array(allocationSchema).max(200).default([]),
    paymentMethod: z.string().trim().max(64).nullish(),
    reference: z.string().trim().max(200).nullish(),
    memo: z.string().trim().max(2000).nullish(),
  })
  .strict();

export const allocatePaymentSchema = z
  .object({ allocations: z.array(allocationSchema).min(1).max(200) })
  .strict();

export const allocateDebitNoteSchema = z
  .object({ allocations: z.array(allocationSchema).min(1).max(200) })
  .strict();

export const reversePaymentSchema = z
  .object({
    /** Defaults to the payment date; its period must be open. */
    reversalDate: isoDate.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const listApPaymentsQuerySchema = z
  .object({
    partyId: z.string().min(1).optional(),
    status: z.enum(["POSTED", "REVERSED"]).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type PostApPaymentInput = z.infer<typeof postApPaymentSchema>;
export type AllocatePaymentInput = z.infer<typeof allocatePaymentSchema>;
export type AllocateDebitNoteInput = z.infer<typeof allocateDebitNoteSchema>;
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;
export type ListApPaymentsQuery = z.infer<typeof listApPaymentsQuerySchema>;
export type WithholdingInstruction = z.infer<typeof withholdingInstructionSchema>;
export type AllocationInput = z.infer<typeof allocationSchema>;
