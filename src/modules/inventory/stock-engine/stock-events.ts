import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { OutboxEventInput } from "../../../common/outbox/outbox-event-schema";
import type { StockEngineCommand, StockEngineResult } from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * A5 — the event the engine owes the rest of the system.
 *
 * Every stock movement was recorded in `inv_stock_transactions` and in an audit
 * row, and neither is an event: the audit row is a private record of who did
 * what, and nothing subscribes to a table. So a movement posted by the engine
 * was invisible to webhooks, to integrations and to any consumer that needs to
 * know stock moved — the PRD's event contract existed on paper only.
 *
 * One event per accepted command rather than per movement, because a command is
 * the unit that either happened or did not: a transfer's two legs are one fact
 * about the world, and a consumer that saw one without the other would draw the
 * wrong conclusion. A replayed command emits nothing at all, since the engine
 * returns the stored result before it reaches this point.
 *
 * The payload is evidence, not a second ledger. It carries enough to identify
 * what moved and to fetch the rest — ids, the SKU and warehouse a consumer
 * cannot look up cheaply, the resulting position — and deliberately not the
 * cost layers, the reservations or anything else the ledger already owns.
 */

interface MovementFact {
  transactionId: number;
  productVariantId: number;
  sku: string | null;
  locationId: number;
  warehouseId: number | null;
  transactionType: string;
  quantityBucket: string;
  quantityChange: string;
  /** The bucket's value after this movement — the projection, as posted. */
  quantityAfter: string;
}

/**
 * Resolves the SKU and warehouse for the movements in one query.
 *
 * A consumer holding only a variant id has to join two tables to learn what
 * moved, and an event that makes every subscriber do that has not really said
 * anything. One round trip here beats one per subscriber forever.
 */
async function describeMovements(
  tx: Tx,
  orgId: string,
  transactionIds: readonly number[],
): Promise<MovementFact[]> {
  if (transactionIds.length === 0) return [];

  const rows = await tx.execute<{
    id: number;
    product_variant_id: number;
    sku: string | null;
    location_id: number | null;
    warehouse_id: number | null;
    transaction_type: string;
    quantity_bucket: string;
    quantity_change: string;
    quantity_after: string;
  }>(sql`
    SELECT t.id,
           t.product_variant_id,
           v.sku,
           t.location_id,
           l.warehouse_id,
           t.transaction_type::text AS transaction_type,
           t.quantity_bucket::text  AS quantity_bucket,
           t.quantity_change::text  AS quantity_change,
           t.quantity_after::text   AS quantity_after
      FROM inv_stock_transactions t
      LEFT JOIN inv_product_variants v
        ON v.org_id = t.org_id AND v.id = t.product_variant_id
      LEFT JOIN inv_locations l
        ON l.org_id = t.org_id AND l.id = t.location_id
     WHERE t.org_id = ${orgId}
       AND t.id IN (${sql.join(transactionIds.map((id) => sql`${id}`), sql`, `)})
     ORDER BY t.id
  `);

  return rows.map((row) => ({
    transactionId: Number(row.id),
    productVariantId: Number(row.product_variant_id),
    sku: row.sku,
    locationId: Number(row.location_id),
    warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
    transactionType: row.transaction_type,
    quantityBucket: row.quantity_bucket,
    quantityChange: row.quantity_change,
    quantityAfter: row.quantity_after,
  }));
}

export const STOCK_MOVEMENT_POSTED = "inventory.stock.movement.posted";

/**
 * Emits `inventory.stock.movement.posted` for one accepted engine command.
 *
 * Written inside the caller's transaction, so the movement and the event commit
 * together or not at all. An event published for a movement that rolled back is
 * worse than no event: every consumer acts on stock that does not exist.
 */
export async function emitStockMovementPosted(
  tx: Tx,
  orgId: string,
  userId: string,
  cmd: StockEngineCommand,
  result: StockEngineResult,
  postingDate: string,
): Promise<void> {
  if (result.transactionIds.length === 0) return;

  const movements = await describeMovements(tx, orgId, result.transactionIds);

  const event: OutboxEventInput = {
    eventId: randomUUID(),
    organizationId: orgId,
    aggregateType: "inv_stock_movement",
    // The command, not a movement: this is the id a consumer deduplicates on,
    // and it is what the idempotency key already guarantees is unique.
    aggregateId: cmd.idempotencyKey,
    aggregateVersion: Date.now(),
    eventType: STOCK_MOVEMENT_POSTED,
    payload: {
      idempotencyKey: cmd.idempotencyKey,
      sourceType: cmd.sourceType,
      sourceId: cmd.sourceId,
      reason: cmd.reason ?? null,
      postingDate,
      actorUserId: userId,
      movements,
      levels: result.levels,
    },
    occurredAt: new Date(),
  };

  await OutboxWriter.emit(tx, event);
}
