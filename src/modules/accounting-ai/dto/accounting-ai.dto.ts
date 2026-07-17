import { z } from "zod";

export const varianceExplainSchema = z.object({
  periodLabel: z.string(),
  accountName: z.string(),
  accountCode: z.string(),
  budgetAmount: z.number(),
  actualAmount: z.number(),
  varianceAmount: z.number(),
  variancePct: z.number(),
  priorPeriodAmount: z.number().optional(),
  notes: z.string().optional(),
});

export const reconciliationExplainSchema = z.object({
  matchId: z.number(),
});

export const extractDocumentSchema = z.object({
  fileBase64: z.string(),
  mimeType: z.string(),
  sourceDocumentName: z.string(),
});

export type VarianceExplainInput = z.infer<typeof varianceExplainSchema>;
export type ReconciliationExplainInput = z.infer<typeof reconciliationExplainSchema>;
export type ExtractDocumentInput = z.infer<typeof extractDocumentSchema>;
