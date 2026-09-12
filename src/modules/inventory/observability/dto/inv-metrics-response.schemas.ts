import { z } from "zod";

/**
 * G6 — `InventoryMetricsSnapshot` (`inventory-metrics.service.ts`).
 *
 * The nullable gauges are null because the question does not arise rather than
 * because the answer is zero: an organisation with no active reservation has no
 * oldest one, and an empty outbox has no lag. Reporting either as `0` would read
 * as healthy when it is simply unmeasured.
 */
export const inventoryMetricsResponseSchema = z.object({
  invariants: z.object({
    negativeLevels: z.number().int(),
    orphanedReservations: z.number().int(),
  }),
  ageing: z.object({
    oldestActiveReservationHours: z.number().nullable(),
    expiredUnreleasedReservations: z.number().int(),
  }),
  outbox: z.object({
    pending: z.number().int(),
    dead: z.number().int(),
    lagSeconds: z.number().nullable(),
  }),
  imports: z.object({ failedJobs: z.number().int() }),
  /** In-process rates, reset on deploy — which `countersNote` states rather than hides. */
  counters: z.record(z.string(), z.number()),
  countersNote: z.string(),
});
