import { sql, type SQL } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { availableQtySumSql } from "../../stock-engine/available-sql";
import type { AvailabilityQueryInput } from "../dto/inv-stock.schemas";

/**
 * A2 — one variant's position, rolled up.
 *
 * Four independent aggregates and no pagination, no cache and no row shape: this
 * answers "how much of this is there, and how much is spoken for" rather than
 * listing anything, which is why it sat beside two list endpoints looking
 * nothing like them. Its arithmetic is the part worth reading on its own —
 * availability is summed per row by the one definition in `available-sql.ts`,
 * because once availability became a function of WHERE each row stands, summing
 * the buckets first and subtracting afterwards could no longer express "and none
 * of it is in a van".
 *
 * The resolved scope arrives as a fragment rather than being resolved here. That
 * keeps the caller identity, the resolve and the application of it in one place
 * — `InvStockService`, which the warehouse-scope gate reads — instead of
 * splitting a scope decision across two files.
 */
export async function readAvailability(
  db: Db,
  orgId: string,
  filters: AvailabilityQueryInput,
  scope: { sql: SQL; key: string },
) {
  const { variantId, warehouseId } = filters;

  // [B1-09] stockRow, incomingRow, outgoingRow are fully independent — run in parallel.
  // [B1-23] No typed generic on db.execute; fields read via String()/Number() converters below.
  const [stockRows, incomingRows, outgoingRows, warehouseBreakdown] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(SUM(on_hand::numeric), 0)::text AS on_hand,
        COALESCE(SUM(committed::numeric), 0)::text AS committed,
        COALESCE(SUM(COALESCE(blocked_qty, 0)::numeric), 0)::text AS blocked_qty,
        COALESCE(SUM(COALESCE(quality_hold_qty, 0)::numeric), 0)::text AS quality_hold_qty,
        COALESCE(SUM(COALESCE(outgoing_qty, 0)::numeric), 0)::text AS outgoing_qty,
        -- A2. Availability is summed per row, by the one definition, because
        -- it is now a function of where each row stands as well as of its
        -- buckets. Summing the buckets first and subtracting afterwards -- as
        -- this did -- cannot express "and none of it is in a van", so goods in
        -- transit were promisable. on_hand above deliberately still counts
        -- them: they exist, and the org's total must not dip while they move.
        ${availableQtySumSql("sl")}::text AS available
      FROM inv_stock_levels sl
      WHERE sl.org_id = ${orgId} AND sl.product_variant_id = ${variantId}
      ${scope.sql}
      ${warehouseId ? sql`AND sl.location_id IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId})` : sql``}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM((pl.quantity::numeric - pl.quantity_received::numeric)), 0)::text AS incoming
      FROM inv_po_lines pl
      JOIN inv_purchase_orders po ON po.id = pl.po_id
      WHERE po.org_id = ${orgId}
        AND pl.product_variant_id = ${variantId}
        AND po.status IN ('SENT', 'PARTIAL')
        ${warehouseId ? sql`AND po.warehouse_id = ${warehouseId}` : sql``}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM((sl.quantity::numeric - sl.quantity_shipped::numeric)), 0)::text AS outgoing
      FROM inv_so_lines sl
      JOIN inv_sales_orders so ON so.id = sl.so_id
      WHERE so.org_id = ${orgId}
        AND sl.product_variant_id = ${variantId}
        AND so.status IN ('CONFIRMED', 'SHIPPED')
        ${warehouseId ? sql`AND so.warehouse_id = ${warehouseId}` : sql``}
    `),
    db.execute(sql`
      SELECT
        w.id AS warehouse_id,
        w.name AS warehouse_name,
        COALESCE(SUM(sl.on_hand::numeric), 0)::text AS on_hand,
        COALESCE(SUM(sl.committed::numeric), 0)::text AS committed,
        ${availableQtySumSql("sl")}::text AS available
      FROM inv_stock_levels sl
      JOIN inv_locations loc ON loc.id = sl.location_id
      JOIN inv_warehouses w ON w.id = loc.warehouse_id
      WHERE sl.org_id = ${orgId} AND sl.product_variant_id = ${variantId}
      ${warehouseId ? sql`AND w.id = ${warehouseId}` : sql``}
      GROUP BY w.id, w.name
    `),
  ]);

  const stockRow = stockRows[0];
  const incomingRow = incomingRows[0];
  const outgoingRow = outgoingRows[0];

  const onHand = parseFloat(String(stockRow?.["on_hand"] ?? "0"));
  const committed = parseFloat(String(stockRow?.["committed"] ?? "0"));
  const incoming = parseFloat(String(incomingRow?.["incoming"] ?? "0"));
  const outgoing = parseFloat(String(outgoingRow?.["outgoing"] ?? "0"));

  // A1/A2. Exact and complete, and computed by the one definition in
  // `available-sql.ts`. This used to be a TypeScript re-derivation from the
  // summed buckets: it dropped outgoing_qty, it used floats, and once
  // availability became location-aware it could not have been made right at
  // all, because the sum has already thrown away which location each row was.
  //
  // `outgoing` below is open sales-order demand, not the `outgoing_qty`
  // projection bucket — picked, not yet shipped. Conflating the two is easy
  // and produces a number that looks right.
  const available = parseFloat(String(stockRow?.["available"] ?? "0"));
  const forecasted = onHand + incoming - outgoing;

  return {
    variantId,
    onHand: onHand.toFixed(4),
    available: available.toFixed(4),
    committed: committed.toFixed(4),
    incoming: incoming.toFixed(4),
    outgoing: outgoing.toFixed(4),
    forecasted: forecasted.toFixed(4),
    warehouseBreakdown,
  };
}
