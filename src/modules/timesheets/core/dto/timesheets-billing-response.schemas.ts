import { z } from "zod";

export const convertedTotalsSchema = z.object({
  baseCurrency: z.string(),
  totalInBase: z.number(),
  rates: z.record(z.string(), z.number()),
  isPartial: z.boolean(),
}).nullable();

export const billingUninvoicedResponseSchema = z.object({
  groups: z.array(z.object({
    projectId: z.number().int(),
    projectName: z.string(),
    totalHours: z.number(),
    billableAmount: z.number(),
    currency: z.string(),
    entryCount: z.number().int(),
    missingRate: z.boolean(),
  })),
  totals: z.object({
    hours: z.number(),
    amount: z.number().nullable(),
    currency: z.string().nullable(),
    mixed: z.boolean(),
    byCurrency: z.array(z.object({ currency: z.string(), amount: z.number(), hours: z.number() })),
    converted: convertedTotalsSchema,
  }),
});

export const billingExportResponseSchema = z.object({
  exportId: z.number().int(),
  entryCount: z.number().int(),
  totalHours: z.number(),
  totalAmount: z.number(),
  duplicate: z.boolean().optional(),
  fileName: z.string().optional(),
  csv: z.string().optional(),
});

export const billingInvoiceDraftResponseSchema = z.object({
  exportId: z.number().int(),
  entryCount: z.number().int(),
  amount: z.number(),
});

export const billingRatePreviewResponseSchema = z.object({
  billRate: z.number().nullable(),
  costRate: z.number().nullable(),
  currency: z.string(),
  source: z.enum(["RATE_CARD", "PROJECT_MEMBER"]).nullable(),
});
