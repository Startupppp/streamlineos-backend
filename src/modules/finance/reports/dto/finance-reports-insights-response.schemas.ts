import { z } from "zod";

const anomalyDrillSchema = z.object({
  type: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});

export const anomalyFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  kind: z.enum([
    "EXPENSE_SPIKE",
    "DUPLICATE_BILL_SUSPECT",
    "UNUSUAL_JOURNAL",
    "ROUND_AMOUNT_PATTERN",
    "AR_CONCENTRATION",
    "CASH_DIP_PROJECTED",
  ]),
  title: z.string(),
  detail: z.string(),
  drill: anomalyDrillSchema,
});

export type AnomalyFinding = z.infer<typeof anomalyFindingSchema>;

export const anomaliesResponseSchema = z.array(anomalyFindingSchema);

export const digestResponseSchema = z.object({
  headline: z.string(),
  positives: z.array(z.string()),
  watchouts: z.array(z.string()),
});
