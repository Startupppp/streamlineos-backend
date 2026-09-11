import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";
import {
  apDocumentTypeEnum,
  documentStatusEnum,
  taxCategoryEnum,
  taxGlRoleEnum,
  taxSupplyNatureEnum,
} from "../../../../db/schema";

/**
 * The AP wire shapes, transcribed from `ap.types.ts`.
 *
 * That file already declares every response this module returns — services here
 * never hand back an ORM row — so these schemas track it field for field rather
 * than re-deriving anything from the tables. Money is integer minor units;
 * `fxRate` is the one `numeric` column that reaches the wire, and postgres-js
 * gives it back as a string.
 */

const apDocumentTypeSchema = z.enum(apDocumentTypeEnum.enumValues);
const documentStatusSchema = z.enum(documentStatusEnum.enumValues);
const taxCategorySchema = z.enum(taxCategoryEnum.enumValues);

/* -------------------------------------------------------------- documents */

const apDocumentSummarySchema = z.object({
  id: z.string(),
  bookId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  documentType: apDocumentTypeSchema,
  status: documentStatusSchema,
  documentNumber: z.string().nullable(),
  vendorDocumentNumber: z.string().nullable(),
  vendorDocumentDate: z.string().nullable(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  fxRate: z.string(),
  supplyNature: z.enum(taxSupplyNatureEnum.enumValues),
  reverseCharge: z.boolean(),
  blockedInputTax: z.boolean(),
  taxInclusive: z.boolean(),
  netMinor: z.number().int(),
  taxMinor: z.number().int(),
  grossMinor: z.number().int(),
  roundingMinor: z.number().int(),
  settledMinor: z.number().int(),
  openMinor: z.number().int(),
  functionalGrossMinor: z.number().int(),
  gstrPeriod: z.string().nullable(),
  postedJournalId: z.string().nullable(),
  postedAt: nullableWireDate(),
  memo: z.string().nullable(),
  reference: z.string().nullable(),
});

const apDocumentLineSchema = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  description: z.string(),
  quantityMilli: z.number().int(),
  unit: z.string().nullable(),
  unitPriceMinor: z.number().int(),
  discountMinor: z.number().int(),
  taxCategory: taxCategorySchema,
  commodityCode: z.string().nullable(),
  expenseAccountId: z.string().nullable(),
  capitalize: z.boolean(),
  lineNetMinor: z.number().int(),
  lineTaxMinor: z.number().int(),
  lineGrossMinor: z.number().int(),
  dimensionProjectId: z.number().int().nullable(),
  dimensionCostCenterId: z.string().nullable(),
});

const apDocumentDetailSchema = apDocumentSummarySchema.extend({
  originalDocumentId: z.string().nullable(),
  placeOfSupplyCode: z.string().nullable(),
  taxLocationFromCountry: z.string().nullable(),
  taxLocationFromRegion: z.string().nullable(),
  taxLocationToCountry: z.string().nullable(),
  taxLocationToRegion: z.string().nullable(),
  dimensionProjectId: z.number().int().nullable(),
  lines: z.array(apDocumentLineSchema),
});

export const getApDocumentResponseSchema = apDocumentDetailSchema;
export const createApDocumentResponseSchema = apDocumentDetailSchema;
export const updateApDocumentResponseSchema = apDocumentDetailSchema;

export const listApDocumentsResponseSchema = z.object({
  items: z.array(apDocumentSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

/** A draft is deleted outright; a posted document never reaches here. */
export const removeApDocumentResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});

const taxDiagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  documentLineId: z.string().optional(),
});

export const apTaxPreviewResponseSchema = z.object({
  documentId: z.string(),
  currency: z.string(),
  netMinor: z.number().int(),
  taxMinor: z.number().int(),
  selfAssessedTaxMinor: z.number().int(),
  blockedTaxMinor: z.number().int(),
  roundingMinor: z.number().int(),
  grossMinor: z.number().int(),
  lines: z.array(
    z.object({
      documentLineId: z.string(),
      taxCode: z.string(),
      taxCodeId: z.string().nullable(),
      category: taxCategorySchema,
      taxableMinor: z.number().int(),
      totalTaxMinor: z.number().int(),
      components: z.array(
        z.object({
          component: z.string(),
          jurisdiction: z.string(),
          rateBp: z.number().int(),
          taxableMinor: z.number().int(),
          taxMinor: z.number().int(),
          recoverable: z.boolean(),
          glRole: z.enum(taxGlRoleEnum.enumValues),
          glAccountId: z.string().nullable(),
        }),
      ),
    }),
  ),
  errors: z.array(taxDiagnosticSchema),
  warnings: z.array(taxDiagnosticSchema),
});

export const postApDocumentResponseSchema = z.object({
  document: apDocumentDetailSchema,
  journalId: z.string(),
  journalNumber: z.string(),
  replayed: z.boolean(),
  selfAssessedTaxMinor: z.number().int(),
});

/* --------------------------------------------------------------- payments */

const apPaymentSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  paymentNumber: z.string().nullable(),
  paymentDate: z.string(),
  paymentAccountId: z.string(),
  currency: z.string(),
  fxRate: z.string(),
  grossMinor: z.number().int(),
  withheldMinor: z.number().int(),
  netPaidMinor: z.number().int(),
  unappliedMinor: z.number().int(),
  status: z.enum(["POSTED", "REVERSED"]),
  paymentMethod: z.string().nullable(),
  reference: z.string().nullable(),
  memo: z.string().nullable(),
  postedJournalId: z.string().nullable(),
  reversalJournalId: z.string().nullable(),
  allocations: z.array(
    z.object({
      id: z.string(),
      documentId: z.string(),
      documentNumber: z.string().nullable(),
      vendorDocumentNumber: z.string().nullable(),
      amountMinor: z.number().int(),
      createdAt: wireDate(),
    }),
  ),
  withholding: z.array(
    z.object({
      id: z.string(),
      regime: z.string(),
      legacySection: z.string().nullable(),
      paymentCode: z.string().nullable(),
      rateBp: z.number().int(),
      baseMinor: z.number().int(),
      withheldMinor: z.number().int(),
      currency: z.string(),
      glAccountId: z.string().nullable(),
      remittanceReference: z.string().nullable(),
    }),
  ),
});

export const getApPaymentResponseSchema = apPaymentSchema;
/** Allocating and reversing both re-read the payment, so both answer with it. */
export const allocateApPaymentResponseSchema = apPaymentSchema;
export const reverseApPaymentResponseSchema = apPaymentSchema;

export const listApPaymentsResponseSchema = z.object({
  items: z.array(apPaymentSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const postApPaymentResponseSchema = z.object({
  payment: apPaymentSchema,
  journalId: z.string(),
  journalNumber: z.string(),
  replayed: z.boolean(),
});

/**
 * Applying a debit note posts no journal — both documents already moved AP
 * control — so it answers with the arithmetic rather than a payment.
 */
export const allocateDebitNoteResponseSchema = z.object({
  debitNoteId: z.string(),
  appliedMinor: z.number().int(),
  remainingMinor: z.number().int(),
});

/* ------------------------------------------------------------------ aging */

const apAgingBucketsSchema = z.object({
  "0-30": z.number().int(),
  "31-60": z.number().int(),
  "61-90": z.number().int(),
  "91+": z.number().int(),
});

export const apAgingResponseSchema = z.object({
  bookId: z.string(),
  asOf: z.string(),
  functionalCurrency: z.string(),
  buckets: apAgingBucketsSchema,
  totalMinor: z.number().int(),
  parties: z.array(
    z.object({
      partyId: z.string(),
      partyName: z.string(),
      buckets: apAgingBucketsSchema,
      totalMinor: z.number().int(),
      items: z.array(
        z.object({
          documentId: z.string(),
          documentType: apDocumentTypeSchema,
          documentNumber: z.string().nullable(),
          vendorDocumentNumber: z.string().nullable(),
          issueDate: z.string(),
          dueDate: z.string().nullable(),
          currency: z.string(),
          openMinor: z.number().int(),
          functionalOpenMinor: z.number().int(),
          daysOverdue: z.number().int(),
          bucket: z.enum(["0-30", "31-60", "61-90", "91+"]),
        }),
      ),
    }),
  ),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalParties: z.number().int(),
});
