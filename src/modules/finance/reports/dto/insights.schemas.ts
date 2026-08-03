import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const insightsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

export type AnomalySeverity = "info" | "warning" | "critical";

export type AnomalyKind =
  | "EXPENSE_SPIKE"
  | "DUPLICATE_BILL_SUSPECT"
  | "UNUSUAL_JOURNAL"
  | "ROUND_AMOUNT_PATTERN"
  | "AR_CONCENTRATION"
  | "CASH_DIP_PROJECTED";

export interface AnomalyDrill {
  type: string;
  params: Record<string, string | number>;
}

export interface AnomalyFinding {
  id: string;
  severity: AnomalySeverity;
  kind: AnomalyKind;
  title: string;
  detail: string;
  drill: AnomalyDrill;
}
