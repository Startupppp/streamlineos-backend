import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const evidenceSnapshotSchema = z.object({
  periodLabel: z.string().optional(),
  accountName: z.string().optional(),
  accountCode: z.string().optional(),
  budgetAmount: z.number().optional(),
  actualAmount: z.number().optional(),
  varianceAmount: z.number().optional(),
  variancePct: z.number().optional(),
  priorPeriodAmount: z.number().optional(),
  notes: z.string().optional(),
});

export const explainVarianceResponseSchema = z.object({
  narration: z.string(),
  factors: z.array(z.string()),
  suggestedInvestigations: z.array(z.string()),
  evidenceSnapshot: evidenceSnapshotSchema,
  generatedAt: wireDate(),
});

const bankTxnSnapshotSchema = z.object({
  date: z.string(),
  amount: z.number(),
  description: z.string(),
  counterparty: z.string().optional(),
});

const jeSnapshotSchema = z.object({
  entryNumber: z.string(),
  entryDate: z.string(),
  description: z.string(),
  totalDebit: z.number(),
  totalCredit: z.number(),
});

const reconEvidenceSchema = z.object({
  matchId: z.number().int(),
  matchedType: z.string(),
  bankTxn: bankTxnSnapshotSchema,
  journalEntry: jeSnapshotSchema.optional(),
  confidence: z.number().optional(),
  isConfirmed: z.boolean(),
});

export const explainReconciliationResponseSchema = z.object({
  narration: z.string(),
  factors: z.array(z.string()),
  evidenceSnapshot: reconEvidenceSchema,
  generatedAt: wireDate(),
});

const extractedLineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
  lineTotal: z.number().nullable(),
});

const extractedDocumentSchema = z.object({
  vendor: z.string(),
  documentDate: z.string().nullable(),
  documentNumber: z.string().nullable(),
  currency: z.string(),
  subtotalAmount: z.number().nullable(),
  taxAmount: z.number().nullable(),
  totalAmount: z.number().nullable(),
  lineItems: z.array(extractedLineItemSchema),
  paymentTerms: z.string().nullable(),
  notes: z.string().nullable(),
});

export const extractDocumentResponseSchema = z.object({
  draft: extractedDocumentSchema,
  sourceDocumentName: z.string(),
  mimeType: z.string(),
  confidence: z.number(),
  reviewRequired: z.literal(true),
  warningMessage: z.string(),
  generatedAt: wireDate(),
});
