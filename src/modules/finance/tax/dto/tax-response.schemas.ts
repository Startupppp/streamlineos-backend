import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const taxCodeSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  code: z.string(),
  rate: z.string(),
  taxType: z.string(),
  isReverseCharge: z.boolean(),
  collectedAccountId: z.number().int().nullable(),
  paidAccountId: z.number().int().nullable(),
  isActive: z.boolean(),
  createdAt: nullableWireDate(),
  updatedAt: nullableWireDate(),
});

export const taxCodeListResponseSchema = cursorPageSchema(taxCodeSchema);

export const taxCodeSeedResponseSchema = z.object({
  seeded: z.number().int(),
  skipped: z.number().int(),
});

const taxPaymentSchema = z.object({
  id: z.number().int(),
  taxType: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  amount: z.string(),
  paidDate: z.string(),
  reference: z.string().nullable(),
  journalEntryId: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: nullableWireDate(),
});

export const taxPaymentListResponseSchema = z.object({
  items: z.array(taxPaymentSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.number().int().nullable(),
  }),
});

export const taxPaymentCreatedResponseSchema = taxPaymentSchema.extend({
  orgId: z.string(),
  archivedAt: nullableWireDate(),
  archivedBy: z.string().nullable(),
  archivedReason: z.string().nullable(),
});

export const taxPaymentDeleteResponseSchema = z.object({ archived: z.boolean() });

export const taxAdjustmentCreatedResponseSchema = z.object({
  entryId: z.number().int(),
  entryNumber: z.string(),
});

const taxRateGroupSchema = z.object({
  rate: z.string(),
  taxableValue: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  igst: z.string(),
  total: z.string(),
  docCount: z.number().int(),
});

const recentTaxPaymentSchema = z.object({
  id: z.number().int(),
  taxType: z.string(),
  amount: z.string(),
  paidDate: z.string(),
  reference: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
});

export const taxDashboardResponseSchema = z.object({
  period: z.object({ from: z.string(), to: z.string() }),
  outputTaxByRate: z.array(taxRateGroupSchema),
  inputTaxByRate: z.array(taxRateGroupSchema),
  summary: z.object({
    totalOutputTax: z.string(),
    totalInputTax: z.string(),
    netLiability: z.string(),
    unpaidLiability: z.string(),
    taxPayableBalance: z.string(),
    taxReceivableBalance: z.string(),
  }),
  recentPayments: z.array(recentTaxPaymentSchema),
  nextDue: z.object({ gstr1: z.string(), gstr3b: z.string() }),
});

const taxLineSchema = z.object({
  sourceType: z.string(),
  sourceId: z.number().int(),
  docNumber: z.string(),
  date: z.string(),
  partyName: z.string(),
  taxableValue: z.string(),
  gstRate: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  igst: z.string(),
  total: z.string(),
});

export const taxOutputReportResponseSchema = cursorPageSchema(taxLineSchema);
export const taxInputReportResponseSchema = cursorPageSchema(taxLineSchema);

export const taxLiabilitySummaryResponseSchema = z.object({
  period: z.object({ from: z.string(), to: z.string() }),
  months: z.array(
    z.object({
      month: z.string(),
      outputTax: z.string(),
      inputTax: z.string(),
      netLiability: z.string(),
      cumulativeUnpaid: z.string(),
    }),
  ),
  totalOutputTax: z.string(),
  totalInputTax: z.string(),
  totalNetLiability: z.string(),
  taxPayableBalance: z.string(),
});
