import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * A1 — the projection buckets that are not `on_hand`.
 *
 * `outgoing_qty` and `on_order` were read by availability, dashboards and the
 * planner, and written by nothing at all. They sat at their `"0"` default
 * forever, which meant availability quietly ignored two of its five terms:
 * stock picked and standing on the packing bench was offered to the next
 * customer, and goods already on order were invisible to replenishment.
 *
 * The meanings, matching `decimal.ts`:
 *
 *   `outgoing_qty`  picked or packed, not yet shipped. In ATP, because the
 *                   units are physically present and already spoken for.
 *   `on_order`      on a sent purchase order, not yet received. *Not* in ATP —
 *                   they are not in the building — but replenishment must see
 *                   them or it orders the same shortfall every week.
 *
 * Every mutation is relative (`+ delta`) rather than absolute, because two
 * concurrent picks against the same row must both count. An absolute write
 * loses one of them and the loss is invisible.
 */
@Injectable()
export class StockProjectionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Record a pick against a stock row.
   *
   * The tempting implementation — move the quantity from `committed` to
   * `outgoing_qty` — is wrong here, and the reconciliation report catches it:
   * `committed` is a *projection of ACTIVE reservations*, asserted by the
   * `committed_vs_reservations` check, so decrementing it without consuming the
   * reservation makes the projection disagree with its own source. Consuming
   * the reservation at pick time is a different question (when does stock
   * actually leave) and belongs to the unit that moves picking onto the engine.
   *
   * So the meaning fixed here, matching `decimal.ts`:
   *
   *   `committed`     units held by an ACTIVE reservation
   *   `outgoing_qty`  units picked that no reservation covers
   *
   * The two are disjoint by construction, and only the uncovered excess is
   * added — a reserved pick is already excluded from availability by
   * `committed`, and adding it again would subtract the same units twice.
   */
  async recordPicked(
    tx: Tx,
    orgId: string,
    productVariantId: number,
    locationId: number,
    quantity: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE inv_stock_levels
         SET outgoing_qty = COALESCE(outgoing_qty, 0)
                          + GREATEST(0, ${quantity}::numeric - committed)
       WHERE org_id = ${orgId}
         AND product_variant_id = ${productVariantId}
         AND location_id = ${locationId}
    `);
  }

  /** Shipping removes the goods, so the outgoing bucket empties with them. */
  async shipOutgoing(
    tx: Tx,
    orgId: string,
    productVariantId: number,
    locationId: number,
    quantity: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE inv_stock_levels
         SET outgoing_qty = GREATEST(0, COALESCE(outgoing_qty, 0) - ${quantity}::numeric)
       WHERE org_id = ${orgId}
         AND product_variant_id = ${productVariantId}
         AND location_id = ${locationId}
    `);
  }

  /**
   * A purchase order names a warehouse, not a bin, so `on_order` is held at the
   * warehouse's first receivable location. That is a simplification and worth
   * saying out loud: per-location `on_order` would be a fiction either way,
   * because nobody knows which bin the goods will land in until they arrive.
   * Every reader of `on_order` aggregates across the warehouse, so the choice
   * of row does not change any answer.
   */
  async addOnOrder(
    tx: Tx,
    orgId: string,
    productVariantId: number,
    warehouseId: number,
    quantity: string,
  ): Promise<void> {
    await tx.execute(sql`
      WITH target AS (
        SELECT id FROM inv_locations
         WHERE org_id = ${orgId} AND warehouse_id = ${warehouseId}
           AND is_active = true AND is_receivable = true
         ORDER BY id
         LIMIT 1
      )
      INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_order)
      -- Clamped on insert as well as on update. A decrement can arrive for a
      -- row that does not exist yet -- goods received into a bin other than the
      -- one holding the on-order figure -- and inserting a negative trips
      -- migration 0515's non-negative bucket CHECK.
      SELECT ${orgId}, ${productVariantId}, target.id, GREATEST(0, ${quantity}::numeric)
        FROM target
      ON CONFLICT (org_id, product_variant_id, location_id,
                   COALESCE(lot_id, 0), COALESCE(serial_id, 0))
      DO UPDATE SET on_order = GREATEST(
        0, COALESCE(inv_stock_levels.on_order, 0) + ${quantity}::numeric
      )
    `);
  }
}
