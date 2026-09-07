import { z } from "zod";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const customerListResponseSchema = cursorPageSchema(
  z.object({
    clientId: z.number().int(),
    clientName: z.string().nullable(),
    state: z.string().nullable(),
    gstin: z.string().nullable(),
    invoiceCount: z.number().int(),
    outstanding: z.string(),
  }),
);

const customerLedgerLineSchema = z.object({
  date: z.string(),
  entryId: z.number().int(),
  entryNumber: z.string(),
  sourceType: z.string(),
  sourceEvent: z.string().nullable(),
  description: z.string().nullable(),
  invoiceId: z.number().int().nullable(),
  invoiceNumber: z.string().nullable(),
  debit: z.string(),
  credit: z.string(),
  runningBalance: z.string(),
});

export const customerLedgerResponseSchema = z.object({
  summary: z.object({
    clientId: z.number().int(),
    clientName: z.string().nullable(),
    state: z.string().nullable(),
    gstin: z.string().nullable(),
    totalInvoiced: z.string(),
    totalPaid: z.string(),
    outstanding: z.string(),
  }),
  lines: z.array(customerLedgerLineSchema),
});

export const agedReceivablesResponseSchema = z.object({
  asOf: z.string(),
  rows: z.array(
    z.object({
      clientId: z.number().int(),
      clientName: z.string(),
      current: z.string(),
      d1_30: z.string(),
      d31_60: z.string(),
      d61_90: z.string(),
      d91_plus: z.string(),
      total: z.string(),
    }),
  ),
  totals: z.object({
    current: z.string(),
    d1_30: z.string(),
    d31_60: z.string(),
    d61_90: z.string(),
    d91_plus: z.string(),
    total: z.string(),
  }),
});
