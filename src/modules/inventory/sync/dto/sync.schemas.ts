import { z } from "zod";

/**
 * INV-208 — what a device may have queued while it was offline.
 *
 * A closed set of operations, deliberately. A generic "replay this request"
 * envelope would let a queued batch reach any route in the application, and a
 * device that has been offline for six hours is the least trustworthy caller in
 * the system -- its user may have left, its token may have been revoked, and
 * the world it was reasoning about has moved.
 *
 * Every operation carries the device's own id for it. That is the whole basis
 * of duplicate safety: a device that cannot tell whether its last request
 * arrived will send it again, and it must be free to.
 */
const baseOperation = {
  /** The device's id for this operation. Stable across retries by definition. */
  clientOperationId: z.string().min(1).max(200),
  /** When the operator did it, not when we heard. Ordering depends on it. */
  occurredAt: z.string().datetime(),
};

export const syncOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...baseOperation,
      type: z.literal("stock.adjust"),
      productVariantId: z.number().int().positive(),
      locationId: z.number().int().positive(),
      /** Signed: a count correction goes both ways. */
      quantityDelta: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
      reasonCode: z.string().max(50).optional(),
    })
    .strict(),
  z
    .object({
      ...baseOperation,
      type: z.literal("pick.confirm"),
      pickListId: z.number().int().positive(),
      pickLineId: z.number().int().positive(),
      quantityPicked: z.string().regex(/^\d+(\.\d{1,4})?$/),
    })
    .strict(),
]);
export type SyncOperation = z.infer<typeof syncOperationSchema>;

export const syncBatchSchema = z
  .object({
    /**
     * Capped. A device returning from a long outage should send several
     * batches rather than one enormous one: a batch that times out halfway is
     * the worst outcome, because the device cannot tell what landed.
     */
    operations: z.array(syncOperationSchema).min(1).max(100),
  })
  .strict();
export type SyncBatchInput = z.infer<typeof syncBatchSchema>;

export type SyncOutcome = "applied" | "duplicate" | "conflict" | "failed";

export interface SyncOperationResult {
  clientOperationId: string;
  outcome: SyncOutcome;
  /** Present for everything except a clean apply. */
  reason?: string;
}

export interface SyncBatchResult {
  applied: number;
  duplicates: number;
  conflicts: number;
  failures: number;
  results: SyncOperationResult[];
}
