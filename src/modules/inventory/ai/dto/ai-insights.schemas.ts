import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
import { INV_ANOMALY_TYPES } from "../anomalies/inv-anomaly-detectors";

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

/**
 * F3. The type list is the detector registry's, not a second copy of it. It was
 * a hand-written union here before, which is how a detector and its description
 * drift apart.
 */
export type InsightType = (typeof INV_ANOMALY_TYPES)[number];

type InsightSeverity = "high" | "medium" | "low";

export interface InsightCandidate {
  insightType: InsightType;
  severity: InsightSeverity;
  title: string;
  body: string;
  sourceRefs: Record<string, unknown>;
  sourceKey: string;
  /**
   * F3. The site this finding is about, or `null` when the arithmetic spans the
   * whole organisation. Null is not "unknown" — it is a claim that the figure is
   * org-wide, and the queue reads it that way.
   */
  warehouseId: number | null;
  /** The window the detector used when it fired, in days. */
  windowDays: number | null;
  /** Fingerprint of the material figures, for "is this still true?". */
  evidenceHash: string;
}

export const reorderProposalBodySchema = z.object({ variantId: z.number().int().positive(), warehouseId: z.number().int().positive().optional() }).strict();
export const confirmProposalBodySchema = z.object({ proposalId: z.number().int().positive(), token: z.string().min(1) }).strict();
export const digestQuerySchema = z.object({ narrate: z.enum(["true", "false"]).optional() }).strict();
export const supplierDelayQuerySchema = z.object({ vendorId: z.coerce.number().int().positive().optional() }).strict();

export type ReorderProposalBodyInput = z.infer<typeof reorderProposalBodySchema>;
export type ConfirmProposalBodyInput = z.infer<typeof confirmProposalBodySchema>;
export type DigestQueryInput = z.infer<typeof digestQuerySchema>;
export type SupplierDelayQueryInput = z.infer<typeof supplierDelayQuerySchema>;
