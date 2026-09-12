import { z } from "zod";
import { INV_ANOMALY_TYPES } from "../inv-anomaly-detectors";

/**
 * F3 — the anomaly queue's boundary.
 *
 * Every filter is a closed domain. `type` is the detector enum rather than a
 * free string, because a free string here would be the one place in the queue
 * where a caller supplies text that reaches a `WHERE`. It is bound as a
 * parameter either way, but a type that cannot be misspelled cannot be probed
 * with either.
 */

export const listAnomaliesSchema = z
  .object({
    status: z.enum(["NEW", "ACKNOWLEDGED", "DISMISSED"]).optional(),
    type: z.enum(INV_ANOMALY_TYPES).optional(),
    severity: z.enum(["high", "medium", "low"]).optional(),
    /**
     * Narrow to one site. An id outside the caller's own scope is answered
     * 404 by `WarehouseScopeService`, never 403 — a 403 on somebody else's
     * warehouse confirms it exists.
     */
    warehouseId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ListAnomaliesInput = z.infer<typeof listAnomaliesSchema>;

/**
 * Reviewing a finding.
 *
 * Two verbs and a note, and nothing that could become a stock movement. There
 * is deliberately no quantity, no location and no adjustment field on this
 * payload: acknowledging an anomaly is a statement about the queue, and the
 * moment it could carry a number it would be a way to post stock through the AI
 * surface.
 */
export const reviewAnomalySchema = z
  .object({
    action: z.enum(["acknowledge", "dismiss"]),
    /** Why. Bounded, because a table cell is not a document store. */
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type ReviewAnomalyInput = z.infer<typeof reviewAnomalySchema>;
