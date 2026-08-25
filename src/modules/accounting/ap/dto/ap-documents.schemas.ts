import { z } from "zod";

/**
 * Payload validation for bills and debit notes. Zod only — the repo has no
 * decorator DTOs (backend/CLAUDE.md §2) — and `.strict()` everywhere so a
 * client-sent `status`, `documentNumber` or `orgId` is rejected rather than
 * quietly ignored.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const currency = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 currency code");

const fxRate = z
  .string()
  .regex(/^\d+(\.\d{1,10})?$/, "Expected a positive decimal with at most 10 decimal places");

const minorUnits = z.number().int().max(9_007_199_254_740_990);
const nonNegativeMinor = minorUnits.min(0);

export const apDocumentTypeSchema = z.enum(["BILL", "DEBIT_NOTE"]);

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

export const apDocumentLineSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    /** Thousandths. 2500 is 2.5 units; zero is rejected by the DB check too. */
    quantityMilli: z.number().int().refine((v) => v !== 0, "Quantity cannot be zero").default(1000),
    unit: z.string().trim().max(32).nullish(),
    unitPriceMinor: minorUnits,
    discountMinor: nonNegativeMinor.default(0),
    taxCategory: taxCategorySchema.default("standard"),
    commodityCode: z.string().trim().max(32).nullish(),
    /** Overriding pack resolution requires a reason — it is an audit trail. */
    forcedTaxCodeId: z.string().min(1).nullish(),
    forcedTaxReason: z.string().trim().max(500).nullish(),
    expenseAccountId: z.string().min(1).nullish(),
    capitalize: z.boolean().default(false),
    dimensionProjectId: z.number().int().positive().nullish(),
    dimensionCostCenterId: z.string().min(1).nullish(),
  })
  .strict()
  .refine((l) => !l.forcedTaxCodeId || Boolean(l.forcedTaxReason), {
    message: "A forced tax code needs a reason",
    path: ["forcedTaxReason"],
  });

export const createApDocumentSchema = z
  .object({
    bookId: z.string().min(1).optional(),
    documentType: apDocumentTypeSchema.default("BILL"),
    partyId: z.string().min(1),
    vendorDocumentNumber: z.string().trim().min(1).max(64).nullish(),
    vendorDocumentDate: isoDate.nullish(),
    issueDate: isoDate,
    dueDate: isoDate.nullish(),
    currency: currency.optional(),
    fxRate: fxRate.optional(),
    supplyNature: supplyNatureSchema.optional(),
    reverseCharge: z.boolean().optional(),
    blockedInputTax: z.boolean().default(false),
    taxInclusive: z.boolean().default(false),
    placeOfSupplyCode: z.string().trim().max(8).nullish(),
    taxLocationFromCountry: z.string().trim().length(2).nullish(),
    taxLocationFromRegion: z.string().trim().max(8).nullish(),
    taxLocationToCountry: z.string().trim().length(2).nullish(),
    taxLocationToRegion: z.string().trim().max(8).nullish(),
    /** A debit note may point at the bill it corrects. */
    originalDocumentId: z.string().min(1).nullish(),
    memo: z.string().trim().max(2000).nullish(),
    reference: z.string().trim().max(200).nullish(),
    dimensionProjectId: z.number().int().positive().nullish(),
    lines: z.array(apDocumentLineSchema).min(1).max(200),
  })
  .strict();

export const updateApDocumentSchema = createApDocumentSchema
  .omit({ bookId: true, documentType: true })
  .partial()
  .extend({ lines: z.array(apDocumentLineSchema).min(1).max(200).optional() })
  .strict();

export const listApDocumentsQuerySchema = z
  .object({
    documentType: apDocumentTypeSchema.optional(),
    status: z.enum(["DRAFT", "POSTED", "PARTIALLY_PAID", "PAID", "VOID"]).optional(),
    partyId: z.string().min(1).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** Open items only — what a payment run picks from. */
    openOnly: z.coerce.boolean().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type CreateApDocumentInput = z.infer<typeof createApDocumentSchema>;
export type UpdateApDocumentInput = z.infer<typeof updateApDocumentSchema>;
export type ApDocumentLineInput = z.infer<typeof apDocumentLineSchema>;
export type ListApDocumentsQuery = z.infer<typeof listApDocumentsQuerySchema>;
