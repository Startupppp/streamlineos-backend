import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import {
  arDocumentTypeEnum,
  documentStatusEnum,
  taxGlRoleEnum,
  taxSupplyNatureEnum,
} from "../../../../db/schema";
import { postedJournalResponseSchema } from "../../kernel/dto/kernel-response.schemas";

/**
 * The AR wire shapes, transcribed from `ar-documents.types.ts` and
 * `ar-receipts.types.ts`.
 *
 * Posting and reversing answer with the document *and* the journal the kernel
 * returned, so the journal half reuses the kernel's own schema rather than a
 * second description of the same object.
 *
 * The two PDF routes are not here: they write to the `Response` themselves and
 * return bytes, so they declare a binary body with `@ApiOkResponse` instead.
 */

const arDocumentHeaderSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  partyId: z.string(),
  documentType: z.enum(arDocumentTypeEnum.enumValues),
  status: z.enum(documentStatusEnum.enumValues),
  documentNumber: z.string().nullable(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  fxRate: z.string(),
  supplyNature: z.enum(taxSupplyNatureEnum.enumValues),
  taxLocationFromCountry: z.string().nullable(),
  taxLocationFromRegion: z.string().nullable(),
  taxLocationToCountry: z.string().nullable(),
  taxLocationToRegion: z.string().nullable(),
  placeOfSupplyCode: z.string().nullable(),
  taxInclusive: z.boolean(),
  exportWithIgst: z.boolean(),
  netMinor: z.number().int(),
  taxMinor: z.number().int(),
  grossMinor: z.number().int(),
  roundingMinor: z.number().int(),
  functionalGrossMinor: z.number().int(),
  settledMinor: z.number().int(),
  openMinor: z.number().int(),
  originalDocumentId: z.string().nullable(),
  postedJournalId: z.string().nullable(),
  gstrPeriod: z.string().nullable(),
  memo: z.string().nullable(),
  reference: z.string().nullable(),
});

const arDocumentViewSchema = arDocumentHeaderSchema.extend({
  lines: z.array(
    z.object({
      id: z.string(),
      lineNo: z.number().int(),
      description: z.string(),
      quantityMilli: z.number().int(),
      unit: z.string().nullable(),
      unitPriceMinor: z.number().int(),
      discountMinor: z.number().int(),
      taxCategory: z.string(),
      commodityCode: z.string().nullable(),
      forcedTaxCodeId: z.string().nullable(),
      forcedTaxReason: z.string().nullable(),
      incomeAccountId: z.string().nullable(),
      lineNetMinor: z.number().int(),
      lineTaxMinor: z.number().int(),
      lineGrossMinor: z.number().int(),
      dimensionProjectId: z.number().int().nullable(),
      dimensionCostCenterId: z.string().nullable(),
    }),
  ),
});

export const getArDocumentResponseSchema = arDocumentViewSchema;
export const createArDocumentResponseSchema = arDocumentViewSchema;
export const updateArDocumentResponseSchema = arDocumentViewSchema;
/** A credit note raised from a posted invoice is a document like any other. */
export const creditNoteFromInvoiceResponseSchema = arDocumentViewSchema;

/** The list projects `headerColumns()`, so it carries no lines. */
export const listArDocumentsResponseSchema = z.object({
  items: z.array(arDocumentHeaderSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const removeArDocumentResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});

const taxProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
  documentLineId: z.string().optional(),
});

export const arTaxPreviewResponseSchema = z.object({
  currency: z.string(),
  netMinor: z.number().int(),
  taxMinor: z.number().int(),
  grossMinor: z.number().int(),
  roundingMinor: z.number().int(),
  lines: z.array(
    z.object({
      documentLineId: z.string(),
      taxCode: z.string(),
      category: z.string(),
      netMinor: z.number().int(),
      taxMinor: z.number().int(),
      grossMinor: z.number().int(),
      components: z.array(
        z.object({
          component: z.string(),
          jurisdiction: z.string(),
          rateBp: z.number().int(),
          taxableMinor: z.number().int(),
          taxMinor: z.number().int(),
          glRole: z.string(),
          accountId: z.string().nullable(),
        }),
      ),
    }),
  ),
  errors: z.array(taxProblemSchema),
  warnings: z.array(taxProblemSchema),
});

/** The engine's frozen verdict, straight off `tax_document_lines`. */
export const arFrozenTaxLinesResponseSchema = z.array(
  z.object({
    component: z.string(),
    jurisdiction: z.string(),
    rateBp: z.number().int(),
    taxableMinor: z.number().int(),
    taxMinor: z.number().int(),
    currency: z.string(),
    glRole: z.enum(taxGlRoleEnum.enumValues),
    glAccountId: z.string().nullable(),
    documentLineId: z.string().nullable(),
  }),
);

export const postArDocumentResponseSchema = z.object({
  document: arDocumentViewSchema,
  journal: postedJournalResponseSchema,
});

/* --------------------------------------------------------------- receipts */

const arReceiptHeaderSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  partyId: z.string(),
  receiptNumber: z.string().nullable(),
  receiptDate: z.string(),
  depositAccountId: z.string(),
  currency: z.string(),
  fxRate: z.string(),
  amountMinor: z.number().int(),
  unappliedMinor: z.number().int(),
  appliedMinor: z.number().int(),
  status: z.enum(["POSTED", "REVERSED"]),
  paymentMethod: z.string().nullable(),
  reference: z.string().nullable(),
  memo: z.string().nullable(),
  postedJournalId: z.string().nullable(),
  reversalJournalId: z.string().nullable(),
});

const arReceiptViewSchema = arReceiptHeaderSchema.extend({
  allocations: z.array(
    z.object({
      id: z.string(),
      documentId: z.string(),
      documentNumber: z.string().nullable(),
      amountMinor: z.number().int(),
      createdAt: wireDate(),
    }),
  ),
});

export const getArReceiptResponseSchema = arReceiptViewSchema;
export const allocateArReceiptResponseSchema = arReceiptViewSchema;

export const listArReceiptsResponseSchema = z.object({
  items: z.array(arReceiptHeaderSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const createArReceiptResponseSchema = z.object({
  receipt: arReceiptViewSchema,
  journal: postedJournalResponseSchema,
});

/** Null when the receipt carried no journal to mirror. */
export const reverseArReceiptResponseSchema = z.object({
  receipt: arReceiptViewSchema,
  reversalJournal: postedJournalResponseSchema.nullable(),
});

/**
 * Offsetting a credit note moves no money: both legs already hit AR control,
 * so the answer is the arithmetic rather than a journal.
 */
export const allocateCreditNoteResponseSchema = z.object({
  creditNoteId: z.string(),
  allocatedMinor: z.number().int(),
  openMinor: z.number().int(),
});

/* ------------------------------------------------------------------ aging */

const agingBucketsSchema = z.object({
  days0to30: z.number().int(),
  days31to60: z.number().int(),
  days61to90: z.number().int(),
  days91Plus: z.number().int(),
});

export const arAgingResponseSchema = z.object({
  bookId: z.string(),
  asOf: z.string(),
  basis: z.enum(["due", "issue"]),
  baseCurrency: z.string(),
  rows: z.array(
    z.object({
      partyId: z.string(),
      partyName: z.string(),
      currency: z.string(),
      buckets: agingBucketsSchema,
      totalMinor: z.number().int(),
      functionalTotalMinor: z.number().int(),
    }),
  ),
  totals: agingBucketsSchema.extend({
    totalMinor: z.number().int(),
    functionalTotalMinor: z.number().int(),
  }),
  /** The PRD invariant, computed: aging must equal the AR control balance. */
  reconciliation: z.object({
    agingFunctionalMinor: z.number().int(),
    arControlBalanceMinor: z.number().int(),
    differenceMinor: z.number().int(),
    balanced: z.boolean(),
  }),
});

export const arOpenItemsResponseSchema = z.array(
  z.object({
    kind: z.enum(["invoice", "credit_note", "unapplied_receipt"]),
    documentId: z.string(),
    documentNumber: z.string().nullable(),
    partyId: z.string(),
    partyName: z.string(),
    currency: z.string(),
    issueDate: z.string(),
    basisDate: z.string(),
    daysOverdue: z.number().int(),
    bucket: z.enum(["days0to30", "days31to60", "days61to90", "days91Plus"]),
    openMinor: z.number().int(),
    functionalOpenMinor: z.number().int(),
  }),
);
