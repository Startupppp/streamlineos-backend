import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { TRANSIT_LOCATION_CODE } from "../../stock-engine/transit-location.service";
import type { ListStrandedTransitInput } from "../dto/transit-exit.schemas";

/**
 * One transfer line's worth of goods standing at a transit location.
 *
 * `quantity_stranded` is what the **document** says has not arrived, and
 * `transit_on_hand` is what the **projection** says is on that bin at that
 * grain. They are different questions and both are needed: the first is what an
 * exit may move, the second is what is actually there — one transit location
 * serves a whole warehouse, so several transfers' goods share it and a bin with
 * less on it than a document claims is a real discrepancy somebody should see
 * rather than a number to reconcile away.
 */
export interface StrandedTransitRow extends Record<string, unknown> {
  transfer_id: number;
  reference_number: string | null;
  status: string;
  dispatched_at: Date | null;
  transfer_line_id: number;
  product_variant_id: number;
  sku: string | null;
  variant_name: string | null;
  lot_id: number | null;
  lot_number: string | null;
  serial_id: number | null;
  quantity_dispatched: string;
  quantity_received: string;
  quantity_stranded: string;
  transit_location_id: number;
  transit_location_code: string | null;
  transit_warehouse_id: number;
  transit_on_hand: string;
  from_location_id: number;
  to_location_id: number | null;
}

/**
 * R3, item 4 — the stranded-transit queue.
 *
 * Anchored on the transfer rather than on `inv_stock_levels`, because "which
 * document put this here" is the question the abandon command needs answered and
 * a stock level cannot answer it: the transit bin holds the sum of every
 * dispatch out of that warehouse, at a grain that names no document. Walking the
 * other way — from the transfer lines that dispatched more than they received —
 * gives one row per decision somebody has to take, which is what a queue is.
 *
 * `dispatched_at IS NOT NULL` is the gate rather than the status, because a
 * transfer completed straight from PENDING never went through transit at all and
 * its unreceived remainder is a receiving discrepancy, not stranded goods.
 *
 * Two views. `ANY` is everything currently in transit, including a van that left
 * an hour ago and is perfectly fine. `STRANDED` is the subset whose journey is
 * over — the transfer reached COMPLETED and units are still standing at the
 * waypoint — which is the short-receipt case this unit exists for. "Still
 * standing" is read from `inv_stock_levels` at the transit bin, not inferred
 * from the unreceived remainder: an exit moves the goods without changing what
 * the line was owed.
 */
export async function queryStrandedTransit(
  db: Db,
  orgId: string,
  filters: ListStrandedTransitInput,
  warehousePredicate: (column: SQL) => SQL,
): Promise<{
  items: StrandedTransitRow[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const offset = (filters.page - 1) * filters.limit;
  const scoped = warehousePredicate(sql`transit.warehouse_id`);
  const warehouseFilter =
    filters.warehouseId === undefined
      ? sql`TRUE`
      : sql`transit.warehouse_id = ${filters.warehouseId}`;
  // STRANDED asks the stock levels whether units are still standing at the
  // waypoint, rather than inferring it from the line's unreceived remainder.
  // Those two stop agreeing the moment somebody acts on the queue:
  // RETURN_TO_SOURCE moves the units back and never touches `quantity_received`
  // — the line still owes what it always owed — so a returned transfer stayed on
  // the queue for good, and the operator's next act was to return it again.
  const viewFilter =
    filters.view === "STRANDED"
      ? sql`t.status = 'COMPLETED' AND EXISTS (
          SELECT 1
            FROM inv_stock_levels sl
           WHERE sl.org_id = t.org_id
             AND sl.location_id = transit.id
             AND sl.product_variant_id = tl.product_variant_id
             AND sl.lot_id IS NOT DISTINCT FROM tl.lot_id
             AND sl.serial_id IS NOT DISTINCT FROM tl.serial_id
             AND sl.on_hand::numeric > 0
        )`
      : sql`TRUE`;

  const where = sql`
    t.org_id = ${orgId}
    AND t.dispatched_at IS NOT NULL
    AND t.status IN ('IN_TRANSIT', 'COMPLETED')
    AND tl.quantity::numeric > COALESCE(tl.quantity_received::numeric, 0)
    AND ${viewFilter}
    AND ${warehouseFilter}
    AND ${scoped}
  `;

  const from = sql`
    FROM inv_stock_transfers t
    JOIN inv_stock_transfer_lines tl
      ON tl.org_id = t.org_id AND tl.transfer_id = t.id
    JOIN inv_locations src
      ON src.org_id = t.org_id AND src.id = t.from_location_id
    JOIN inv_locations transit
      ON transit.org_id = t.org_id
     AND transit.warehouse_id = COALESCE(t.from_warehouse_id, src.warehouse_id)
     AND transit.code = ${TRANSIT_LOCATION_CODE}
  `;

  const [items, counted] = await Promise.all([
    db.execute<StrandedTransitRow>(sql`
      SELECT t.id AS transfer_id,
             t.reference_number,
             t.status::text AS status,
             t.dispatched_at,
             tl.id AS transfer_line_id,
             tl.product_variant_id,
             v.sku,
             v.name AS variant_name,
             tl.lot_id,
             lot.lot_number,
             tl.serial_id,
             tl.quantity::text AS quantity_dispatched,
             COALESCE(tl.quantity_received, '0')::text AS quantity_received,
             (tl.quantity::numeric - COALESCE(tl.quantity_received::numeric, 0))::text
               AS quantity_stranded,
             transit.id AS transit_location_id,
             transit.code AS transit_location_code,
             transit.warehouse_id AS transit_warehouse_id,
             COALESCE(level.on_hand, 0)::text AS transit_on_hand,
             t.from_location_id,
             t.to_location_id
      ${from}
      JOIN inv_product_variants v
        ON v.org_id = tl.org_id AND v.id = tl.product_variant_id
      LEFT JOIN inv_lots lot
        ON lot.org_id = tl.org_id AND lot.id = tl.lot_id
      LEFT JOIN LATERAL (
        SELECT SUM(sl.on_hand::numeric) AS on_hand
          FROM inv_stock_levels sl
         WHERE sl.org_id = t.org_id
           AND sl.location_id = transit.id
           AND sl.product_variant_id = tl.product_variant_id
           AND sl.lot_id IS NOT DISTINCT FROM tl.lot_id
           AND sl.serial_id IS NOT DISTINCT FROM tl.serial_id
      ) level ON TRUE
      WHERE ${where}
      ORDER BY t.dispatched_at DESC, t.id DESC, tl.id
      LIMIT ${filters.limit} OFFSET ${offset}
    `),
    db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      ${from}
      WHERE ${where}
    `),
  ]);

  const total = Number(counted[0]?.count ?? 0);
  return {
    items: [...items],
    total,
    page: filters.page,
    totalPages: Math.ceil(total / filters.limit),
  };
}
