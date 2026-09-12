import { z } from "zod";
import { queryBoolean } from "../../../../common/validation/query-boolean";

/**
 * Payload schemas for AR invoices and credit notes.
 *
 * Both live in one table discriminated by `documentType`, so both go through
 * these schemas; the controller fixes the type rather than the caller choosing
 * it, which is why `documentType` never appears in a create payload.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

const currency = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 currency code");

/** Positive decimal with at most ten places — the scale of `gl_fx_rates.rate`. */
const fxRate = z
  .string()
  .regex(/^\d+(\.\d{1,10})?$/, "Expected a positive decimal FX rate with up to 10 decimal places");

/** Minor units, always whole. `Number.MAX_SAFE_INTEGER` is the hard ceiling. */
const minorUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const taxCategorySchema = z.enum([
  "standard",
  "reduced",
  "super_reduced",
  "zero",
  "exempt",
  "out_of_scope",
  "reverse_charge",
]);

export const supplyNatureSchema = z.enum([
  "domestic_b2b",
  "domestic_b2c",
  "export",
  "import",
  "intra_community",
  "oss_b2c",
  "reverse_charge",
  "outside_scope",
]);

export const arDocumentLineSchema = z
  .object({
    description: z.string().trim().min(1).max(1000),
    /** Thousandths, so 2.5 hours is `2500` and nothing is ever a float. */
    quantityMilli: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    unit: z.string().trim().max(32).nullish(),
    unitPriceMinor: minorUnits,
    discountMinor: minorUnits.optional(),
    taxCategory: taxCategorySchema.optional(),
    commodityCode: z.string().trim().max(32).nullish(),
    forcedTaxCodeId: z.string().trim().min(1).nullish(),
    forcedTaxReason: z.string().trim().max(500).nullish(),
    incomeAccountId: z.string().trim().min(1).nullish(),
    dimensionProjectId: z.number().int().positive().nullish(),
    dimensionCostCenterId: z.string().trim().min(1).nullish(),
  })
  .strict()
  .refine((l) => (l.forcedTaxCodeId ? Boolean(l.forcedTaxReason) : true), {
    message: "A forced tax code needs a reason for the audit trail",
    path: ["forcedTaxReason"],
  });

export type ArDocumentLineInput = z.infer<typeof arDocumentLineSchema>;

const documentCoreFields = {
  partyId: z.string().trim().min(1),
  issueDate: isoDate,
  dueDate: isoDate.nullish(),
  currency: currency.optional(),
  fxRate: fxRate.optional(),
  supplyNature: supplyNatureSchema.optional(),
  taxLocationFromCountry: z.string().regex(/^[A-Z]{2}$/).nullish(),
  taxLocationFromRegion: z.string().trim().max(16).nullish(),
  taxLocationToCountry: z.string().regex(/^[A-Z]{2}$/).nullish(),
  taxLocationToRegion: z.string().trim().max(16).nullish(),
  placeOfSupplyCode: z.string().trim().max(16).nullish(),
  taxInclusive: z.boolean().optional(),
  exportWithIgst: z.boolean().optional(),
  memo: z.string().trim().max(4000).nullish(),
  reference: z.string().trim().max(255).nullish(),
  crmDealId: z.string().trim().max(191).nullish(),
  dimensionProjectId: z.number().int().positive().nullish(),
  ecommerceGstin: z.string().trim().max(32).nullish(),
};

export const createInvoiceSchema = z
  .object({
    ...documentCoreFields,
    lines: z.array(arDocumentLineSchema).min(1).max(500),
  })
  .strict();
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const createCreditNoteSchema = z
  .object({
    ...documentCoreFields,
    /** The invoice this note corrects, when it corrects one. */
    originalDocumentId: z.string().trim().min(1).nullish(),
    lines: z.array(arDocumentLineSchema).min(1).max(500),
  })
  .strict();
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;

/** Copy an invoice into a draft credit note; omit `lines` to mirror it whole. */
export const creditNoteFromInvoiceSchema = z
  .object({
    issueDate: isoDate.optional(),
    memo: z.string().trim().max(4000).nullish(),
    reference: z.string().trim().max(255).nullish(),
    lines: z.array(arDocumentLineSchema).min(1).max(500).optional(),
  })
  .strict();
export type CreditNoteFromInvoiceInput = z.infer<typeof creditNoteFromInvoiceSchema>;

export const updateDraftSchema = z
  .object({
    ...documentCoreFields,
    partyId: z.string().trim().min(1).optional(),
    issueDate: isoDate.optional(),
    originalDocumentId: z.string().trim().min(1).nullish(),
    lines: z.array(arDocumentLineSchema).min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

export const listArDocumentsSchema = z
  .object({
    partyId: z.string().trim().min(1).optional(),
    status: z.enum(["DRAFT", "POSTED", "PARTIALLY_PAID", "PAID", "VOID"]).optional(),
    /** Documents with an open balance, whatever their status label says. */
    openOnly: queryBoolean.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    search: z.string().trim().max(191).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ListArDocumentsQuery = z.infer<typeof listArDocumentsSchema>;
