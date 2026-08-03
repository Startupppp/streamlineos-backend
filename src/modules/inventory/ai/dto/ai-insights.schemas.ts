import { z } from "zod";

export const listInsightsSchema = z.object({
  status: z.enum(["NEW", "ACKNOWLEDGED", "DISMISSED"]).optional(),
  type: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListInsightsInput = z.infer<typeof listInsightsSchema>;

export const updateInsightStatusSchema = z.object({
  status: z.enum(["ACKNOWLEDGED", "DISMISSED"]),
});
export type UpdateInsightStatusInput = z.infer<typeof updateInsightStatusSchema>;

type InsightType =
  | "stockout_risk"
  | "dead_stock"
  | "vendor_delay"
  | "negative_stock"
  | "unusual_adjustments"
  | "expiry_risk";

type InsightSeverity = "high" | "medium" | "low";

export interface InsightCandidate {
  insightType: InsightType;
  severity: InsightSeverity;
  title: string;
  body: string;
  sourceRefs: Record<string, unknown>;
  sourceKey: string;
}
