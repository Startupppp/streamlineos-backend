import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

/**
 * A5, item 3 — the events that belong to a command rather than to the engine.
 *
 * `stock-events.ts` is the engine's own fact: stock moved. It cannot say *why*,
 * because by the time the engine sees a command the business meaning has been
 * flattened into movements — a dispatch, a receipt and a count correction all
 * arrive as a list of quantity deltas. So a consumer that only ever hears
 * `inventory.stock.movement.posted` knows the numbers changed and nothing else,
 * and every integration that wants "tell me when a transfer arrives" has to
 * reconstruct the intent from the ledger. These are the events that carry it.
 *
 * The rules the engine's event follows apply here unchanged:
 *
 * - Written with `OutboxWriter.emit(tx, …)` **inside the command's own
 *   transaction**, so the state change and the event commit together or not at
 *   all. An event published for work that rolled back has every consumer acting
 *   on something that did not happen.
 * - Where a command claims an idempotency key, the emit sits **inside the
 *   claimed work**. Outside it, a replay re-emits, which is exactly the
 *   duplicate-notification the claim exists to prevent.
 * - One event per accepted command, not per row. A transfer that reserves five
 *   lines is one reservation decision, not five.
 * - The payload is evidence, not a second ledger: the ids a consumer needs to
 *   fetch the rest, plus the one or two fields (a SKU, a warehouse) it would
 *   otherwise have to join two tables for. It deliberately does not restate the
 *   quantities, costs or layers the ledger already owns.
 *
 * Two of the twelve already existed under other names, and item 2 forbids
 * retiring either: `inventory.shipment.dispatched` is the shipment event and
 * keeps that name, and `inventory.purchase_order.received` keeps its own beside
 * the new GRN-level `inventory.receiving.posted`. Nothing emitted before this
 * change stops being emitted by it.
 *
 * ⚠ Adding a name here is half the job. `OutboxPublisher` dispatches through
 * `OutboxConsumerRegistry`, and an event type with no registered consumer is
 * not ignored — it throws "no dispatch handler", retries and dead-letters, in a
 * background worker on somebody else's shift. Every name below must also appear
 * in `INVENTORY_WEBHOOK_ROUTES` (`webhooks/inventory-outbox-consumer.ts`),
 * mapped to a subscriber-facing name or explicitly to `null`, which is a
 * decision rather than an omission. `inventory-outbox-coverage.spec.ts` fails
 * if one is missing.
 */
export const INVENTORY_COMMAND_EVENTS = {
  RESERVATION_CREATED: "inventory.reservation.created",
  RESERVATION_RELEASED: "inventory.reservation.released",
  RESERVATION_CONSUMED: "inventory.reservation.consumed",
  TRANSFER_RESERVED: "inventory.stock.transfer.reserved",
  TRANSFER_DISPATCHED: "inventory.stock.transfer.dispatched",
  TRANSFER_COMPLETED: "inventory.stock.transfer.completed",
  RECEIVING_POSTED: "inventory.receiving.posted",
  RETURN_POSTED: "inventory.return.posted",
  QUALITY_HOLD_CREATED: "inventory.quality.hold.created",
  QUALITY_HOLD_RELEASED: "inventory.quality.hold.released",
  COUNT_POSTED: "inventory.count.posted",
  /**
   * The shipping event, under the name it has always had. Renaming it to
   * `inventory.shipment.shipped` would silently kill every webhook already
   * subscribed to it, and dual-writing both names for one shipment would
   * collide on the outbox's `(org, aggregate_type, aggregate_id,
   * aggregate_version)` unique index — two events about the same aggregate in
   * the same millisecond. So this name is the contract, and the gap it had
   * (the sales-order fulfilment path shipped a shipment and announced nothing)
   * is closed by emitting it there too.
   */
  SHIPMENT_DISPATCHED: "inventory.shipment.dispatched",
} as const;

export type InventoryCommandEventType =
  (typeof INVENTORY_COMMAND_EVENTS)[keyof typeof INVENTORY_COMMAND_EVENTS];

export interface InventoryCommandEvent {
  orgId: string;
  eventType: InventoryCommandEventType;
  /** The table the aggregate lives in — `inv_stock_transfer`, `inv_grn`, … */
  aggregateType: string;
  /** What a consumer deduplicates and orders on. */
  aggregateId: string;
  actorUserId: string;
  payload: Record<string, unknown>;
}

/**
 * Writes one command event into the caller's transaction.
 *
 * Exists so twelve call sites do not each grow their own copy of the envelope —
 * that is how a `randomUUID()` becomes a constant in one of them and a whole
 * event type stops being delivered.
 */
export async function emitInventoryCommandEvent(
  tx: DbOrTx,
  event: InventoryCommandEvent,
): Promise<void> {
  await OutboxWriter.emit(tx, {
    eventId: randomUUID(),
    organizationId: event.orgId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: Date.now(),
    eventType: event.eventType,
    payload: { ...event.payload, actorUserId: event.actorUserId },
    occurredAt: new Date(),
  });
}

/** What a consumer would otherwise join `inv_product_variants` and `inv_locations` for. */
export interface GrainDescription {
  sku: string | null;
  warehouseId: number | null;
}

/**
 * Resolves the SKU and warehouse behind one (variant, location) pair.
 *
 * A single-grain event that carried only a variant id would make every
 * subscriber do this join forever; one round trip here beats one per subscriber.
 * Both sides are LEFT JOINed and both may come back null — a reservation may
 * name no location at all, and an event is not the place to start throwing.
 */
export async function describeGrain(
  tx: DbOrTx,
  orgId: string,
  productVariantId: number,
  locationId: number | null,
): Promise<GrainDescription> {
  const rows = await tx.execute<{ sku: string | null; warehouse_id: number | null }>(sql`
    SELECT v.sku,
           l.warehouse_id
      FROM (SELECT 1) AS anchor
      LEFT JOIN inv_product_variants v
        ON v.org_id = ${orgId} AND v.id = ${productVariantId}
      LEFT JOIN inv_locations l
        ON l.org_id = ${orgId} AND l.id = ${locationId ?? null}
  `);
  const row = rows[0];
  return {
    sku: row?.sku ?? null,
    warehouseId: row?.warehouse_id === null || row?.warehouse_id === undefined
      ? null
      : Number(row.warehouse_id),
  };
}
