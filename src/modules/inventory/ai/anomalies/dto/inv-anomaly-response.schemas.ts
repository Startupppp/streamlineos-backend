import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../../common/openapi/wire-types";
import { invEvidenceReferenceSchema } from "../../dto/inv-ai-contract";

/**
 * F3 — the anomaly queue's wire shapes.
 *
 * `detector` is the registry view (`InvAnomalyDetectorView`), nullable because a
 * finding raised by a detector that has since been retired still has to render:
 * the row keeps what it claimed, and the registry no longer describes it.
 */
const anomalyDetectorViewSchema = z.object({
  type: z.string(),
  label: z.string(),
  formula: z.string(),
  windowLabel: z.string(),
  severityRule: z.string(),
  href: z.string(),
});

/** `InvAnomalyRow` (`inv-anomaly-queue.service.ts`). */
const anomalyRowSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  severity: z.string(),
  status: z.string(),
  title: z.string(),
  body: z.string(),
  warehouseId: z.number().int().nullable(),
  windowDays: z.number().int().nullable(),
  evidenceHash: z.string().nullable(),
  evidence: z.array(invEvidenceReferenceSchema),
  detector: anomalyDetectorViewSchema.nullable(),
  acknowledgedBy: z.string().nullable(),
  acknowledgedAt: nullableWireDate(),
  resolutionNote: z.string().nullable(),
  createdAt: wireDate(),
});

/**
 * `InvAnomalyPage` — the paged envelope plus the honest-gate flag. Not
 * `itemsPagedSchema`, because `orgWideSignalsHidden` is part of the answer: a
 * restricted caller is told that org-wide findings exist and are not theirs.
 */
export const listAnomaliesResponseSchema = z.object({
  items: z.array(anomalyRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
  orgWideSignalsHidden: z.boolean(),
});

export const reviewAnomalyResponseSchema = anomalyRowSchema;

/** `INV_ANOMALY_DETECTORS`, in `INV_ANOMALY_TYPES` order — static for every caller. */
export const listAnomalyDetectorsResponseSchema = z.object({
  detectors: z.array(
    z.object({
      type: z.string(),
      label: z.string(),
      formula: z.string(),
      windowDays: z.number().int().nullable(),
      windowLabel: z.string(),
      severityRule: z.string(),
      evidenceKinds: z.array(z.string()),
      href: z.string(),
      siteAttributable: z.boolean(),
    }),
  ),
});
