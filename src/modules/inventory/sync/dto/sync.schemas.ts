import { z } from "zod";
import {
  nonZeroDecimalQuantity,
  positiveDecimalQuantity,
} from "../../stock-engine/dto/quantity.schemas";
import { createGrnSchema } from "../../purchase-orders/dto/inv-purchase-orders.schemas";

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
 *
 * B8 widened the set from two operations to four. The device queue the unit
 * asks for captures scans, pick confirmations and receive counts, and a queue
 * that can hold an operation the replay endpoint cannot accept is a queue that
 * silently loses work at the dock -- the operator sees "queued" forever, or the
 * drain drops the entry to make the badge go away. Each new kind reaches the
 * service that already owns it online; none of them opens a second stock path.
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
      /**
       * Signed: a count correction goes both ways, and the sign is the whole
       * instruction. B8 moved this onto the shared `nonZeroDecimalQuantity`
       * rather than a local copy of its regex, which admitted `"0"` -- an
       * adjustment of nothing that still burns an idempotency key and writes a
       * ledger row saying a human decided something when they did not.
       */
      quantityDelta: nonZeroDecimalQuantity,
      /**
       * Why the count changed. It selects the ledger type alongside the sign
       * (`SCRAP` rather than `ADJUSTMENT_OUT` for a condemned line), so a
       * movement history can separate shrinkage from a recount.
       */
      reasonCode: z.string().max(50).optional(),
    })
    .strict(),
  z
    .object({
      ...baseOperation,
      type: z.literal("pick.confirm"),
      pickListId: z.number().int().positive(),
      pickLineId: z.number().int().positive(),
      quantityPicked: positiveDecimalQuantity,
    })
    .strict(),
  /**
   * B8 — a delivery counted at the dock with no signal.
   *
   * The line shape is `createGrnSchema`'s, imported rather than restated. A
   * second copy would drift the moment receiving grows a field, and the copy
   * that drifts is always the offline one, because nothing exercises it until a
   * scanner comes back from an outage.
   */
  z
    .object({
      ...baseOperation,
      type: z.literal("receive.count"),
      poId: z.number().int().positive(),
      ...createGrnSchema.shape,
    })
    .strict(),
  /**
   * B8 — a scan captured while the lookup was unreachable.
   *
   * The raw payload, verbatim, exactly as the online route takes it. What the
   * scanner read is a fact; what it means is an interpretation the server makes
   * when the device gets back, against the catalogue as it stands then rather
   * than as the device last saw it.
   */
  z
    .object({
      ...baseOperation,
      type: z.literal("scan.capture"),
      payload: z.string().min(1).max(500),
    })
    .strict(),
]);
export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncOperationType = SyncOperation["type"];

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

/**
 * B8 — the permission each queued operation answers to.
 *
 * The route's own `@RequirePermission` is the door; this is the room. Without
 * it, a device holding only `inventory:stock:adjust` could post a
 * `receive.count` through the replay endpoint and receive a delivery it has no
 * right to receive -- the offline path would be a weaker set of rules for
 * exactly the operations that got the least supervision, which is the one thing
 * this whole service exists not to be.
 *
 * Every key here is one the online route for that operation already requires.
 * No new key is minted: a permission that exists only on the offline path is a
 * permission nobody grants.
 */
export const SYNC_OPERATION_PERMISSIONS: Readonly<
  Record<SyncOperationType, string>
> = {
  "stock.adjust": "inventory:stock:adjust",
  "pick.confirm": "inventory:sales-orders:ship",
  "receive.count": "inventory:purchase-orders:receive",
  "scan.capture": "inventory:stock:read",
};

export type SyncOutcome = "applied" | "duplicate" | "conflict" | "failed";

export interface SyncOperationResult {
  clientOperationId: string;
  outcome: SyncOutcome;
  /** Present for everything except a clean apply. */
  reason?: string;
  /**
   * B8 — a machine-readable name for why, present alongside `reason`.
   *
   * The device has to answer three conflicts differently: the stock is not
   * there, the document moved on, or the same operation is already in flight.
   * Deciding which by matching the prose would put that classification in the
   * UI as well as here, and the operator's options would drift from the reason
   * they were shown the first time somebody reworded a message.
   */
  code?: string;
}

export interface SyncBatchResult {
  applied: number;
  duplicates: number;
  conflicts: number;
  failures: number;
  results: SyncOperationResult[];
}
