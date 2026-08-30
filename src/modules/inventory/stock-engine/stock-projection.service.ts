import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { EXPECTED_OUTGOING } from "./projection-definitions";

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
   * Bring `outgoing_qty` back in line with the documents, for one grain.
   *
   * This replaces `recordPicked` and `shipOutgoing`, which incremented and
   * decremented a running total and were wrong in three separate ways:
   *
   *   They filtered on `(org, variant, location)` while the projection is keyed
   *   on `(org, variant, location, lot, serial)`. One 10-unit pick of a
   *   lot-tracked product wrote 10 to every lot row at that location, so
   *   availability for the variant fell by 30 where three lots were held. Two
   *   grains on the live database already have several rows per location.
   *
   *   The pair was asymmetric: a pick added only the part no reservation
   *   covered, while a ship subtracted the whole picked quantity. Shipping a
   *   reserved order therefore consumed an unreserved order's `outgoing_qty`
   *   and re-offered stock that was standing in a tote.
   *
   *   Cancelling a sales order, and picking a wave, forgot to write at all.
   *
   * Recomputing removes the class rather than the three instances. The value is
   * absolute, so a writer that forgets to run is the only remaining failure and
   * reconciliation catches exactly that; and the expression is the same one the
   * reconciliation check uses, so the checker and the writer cannot disagree.
   *
   * Safe under concurrency for the same reason: two picks against one grain both
   * recompute the same total from the same documents, where two increments could
   * interleave.
   */
  async syncOutgoing(
    tx: Tx,
    orgId: string,
    grain: {
      productVariantId: number;
      locationId: number;
      lotId?: number | null;
      serialId?: number | null;
      /** NEO-4 - part of the level's natural key, so it is part of this one. */
      handlingUnitId?: number | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE inv_stock_levels AS sl
         SET outgoing_qty = ${EXPECTED_OUTGOING}
       WHERE sl.org_id = ${orgId}
         AND sl.product_variant_id = ${grain.productVariantId}
         AND sl.location_id = ${grain.locationId}
         AND sl.lot_id IS NOT DISTINCT FROM ${grain.lotId ?? null}
         AND sl.serial_id IS NOT DISTINCT FROM ${grain.serialId ?? null}
         AND sl.handling_unit_id IS NOT DISTINCT FROM ${grain.handlingUnitId ?? null}
         -- NEO-11. Picks are against owned stock, and the expression above is
         -- gated the same way; without this the recompute would write an owned
         -- figure onto a consigned row standing at the same bin.
         AND sl.ownership = 'OWNED'
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
      -- NEO-4 and NEO-11 widened the natural key with the handling unit and the
      -- ownership. A conflict target that does not match the unique index in full
      -- matches no constraint at all, and Postgres refuses the statement rather
      -- than falling back to a plain insert -- which is how the golden path found
      -- this the moment the key changed. Every column of
      -- uniq_inv_stock_levels_natural_key, in its order.
      ON CONFLICT (org_id, product_variant_id, location_id,
                   COALESCE(lot_id, 0), COALESCE(serial_id, 0),
                   COALESCE(handling_unit_id, 0), ownership)
      DO UPDATE SET on_order = GREATEST(
        0, COALESCE(inv_stock_levels.on_order, 0) + ${quantity}::numeric
      )
    `);
  }
}
