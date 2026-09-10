import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listInsightsSchema = z.object({
  status: z.enum(["NEW", "ACKNOWLEDGED", "DISMISSED"]).optional(),
  type: z.string().optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ListInsightsInput = z.infer<typeof listInsightsSchema>;

export const updateInsightStatusSchema = z.object({
  status: z.enum(["ACKNOWLEDGED", "DISMISSED"]),
}).strict();
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

export const reorderProposalBodySchema = z.object({ variantId: z.number().int().positive(), warehouseId: z.number().int().positive().optional() });
export const confirmProposalBodySchema = z.object({ proposalId: z.number().int().positive(), token: z.string().min(1) });
export const digestQuerySchema = z.object({ narrate: z.enum(["true", "false"]).optional() });
export const supplierDelayQuerySchema = z.object({ vendorId: z.coerce.number().int().positive().optional() });

export type ReorderProposalBodyInput = z.infer<typeof reorderProposalBodySchema>;
export type ConfirmProposalBodyInput = z.infer<typeof confirmProposalBodySchema>;
export type DigestQueryInput = z.infer<typeof digestQuerySchema>;
export type SupplierDelayQueryInput = z.infer<typeof supplierDelayQuerySchema>;
