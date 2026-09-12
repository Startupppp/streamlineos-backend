import { z } from "zod";
import { queryBoolean } from "../../../../common/validation/query-boolean";

/** Payload schemas for customer receipts and their allocation to open items. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

const currency = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 currency code");

const fxRate = z
  .string()
  .regex(/^\d+(\.\d{1,10})?$/, "Expected a positive decimal FX rate with up to 10 decimal places");

const positiveMinor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Where the money landed, named by role so no caller hardcodes an account. */
export const depositAccountTagSchema = z.enum(["bank", "cash", "undeposited", "psp_clearing"]);

export const allocationLineSchema = z
  .object({
    documentId: z.string().trim().min(1),
    amountMinor: positiveMinor,
  })
  .strict();
export type AllocationLineInput = z.infer<typeof allocationLineSchema>;

export const createReceiptSchema = z
  .object({
    partyId: z.string().trim().min(1),
    receiptDate: isoDate,
    depositAccountId: z.string().trim().min(1).optional(),
    depositAccountTag: depositAccountTagSchema.optional(),
    currency: currency.optional(),
    fxRate: fxRate.optional(),
    amountMinor: positiveMinor,
    paymentMethod: z.string().trim().max(64).nullish(),
    reference: z.string().trim().max(255).nullish(),
    memo: z.string().trim().max(4000).nullish(),
    providerPaymentId: z.string().trim().max(191).nullish(),
    /** Apply on the way in; omit and the money sits as a customer advance. */
    allocations: z.array(allocationLineSchema).max(200).optional(),
    /** Oldest open item first, until the receipt is used up. */
    autoAllocateFifo: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.depositAccountId) !== Boolean(v.depositAccountTag), {
    message: "Supply exactly one of depositAccountId or depositAccountTag",
    path: ["depositAccountId"],
  })
  .refine((v) => !(v.allocations && v.autoAllocateFifo), {
    message: "Choose either explicit allocations or FIFO, not both",
    path: ["autoAllocateFifo"],
  });
export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;

export const allocateReceiptSchema = z
  .object({
    allocations: z.array(allocationLineSchema).min(1).max(200),
  })
  .strict();
export type AllocateReceiptInput = z.infer<typeof allocateReceiptSchema>;

export const allocateFifoSchema = z
  .object({
    /** Cap the sweep; defaults to the whole unapplied balance. */
    maxAmountMinor: positiveMinor.optional(),
  })
  .strict();
export type AllocateFifoInput = z.infer<typeof allocateFifoSchema>;

/** Apply a posted credit note to one or more open invoices. */
export const allocateCreditNoteSchema = z
  .object({
    allocations: z.array(allocationLineSchema).min(1).max(200),
  })
  .strict();
export type AllocateCreditNoteInput = z.infer<typeof allocateCreditNoteSchema>;

export const reverseReceiptSchema = z
  .object({
    reversalDate: isoDate.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type ReverseReceiptInput = z.infer<typeof reverseReceiptSchema>;

export const listReceiptsSchema = z
  .object({
    partyId: z.string().trim().min(1).optional(),
    status: z.enum(["POSTED", "REVERSED"]).optional(),
    unappliedOnly: queryBoolean.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ListReceiptsQuery = z.infer<typeof listReceiptsSchema>;
