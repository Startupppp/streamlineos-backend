import { sql, type SQL } from "drizzle-orm";

/**
 * The document-derived value of each projection bucket, written once.
 *
 * `inv_stock_levels` is a projection: `on_hand` and the two hold buckets come
 * from the ledger, and `committed`, `on_order` and `outgoing_qty` come from open
 * documents. Reconciliation already derived all three from these definitions to
 * *check* them; the writers maintained them by incrementing, and every bug found
 * in them came from the two disagreeing.
 *
 * Three of those bugs, all from increment-maintenance:
 *
 *   The writers filtered on `(org, variant, location)` while the projection is
 *   keyed on `(org, variant, location, lot, serial)`, so one 10-unit pick of a
 *   lot-tracked product wrote 10 to *every* lot row at that location and
 *   subtracted 30 from availability. Two grains on the live database already
 *   have several rows per location.
 *
 *   `recordPicked` added only the part no reservation covered, while shipping
 *   subtracted the whole picked quantity — so shipping a reserved order ate an
 *   unreserved order's `outgoing_qty` and re-offered stock that was in a tote.
 *
 *   Cancelling an order, cancelling a purchase order, and picking a wave each
 *   forgot to reverse their side at all.
 *
 * So the writers now recompute from these same expressions instead of adding to
 * a running total. A derived quantity maintained by increments is only ever as
 * correct as its least careful writer; recomputed, it is correct by
 * construction, and the checker and the writer can no longer disagree because
 * they are the same SQL.
 *
 * Each expression is written against a stock-level row aliased `sl`.
 */

/** Held by an ACTIVE reservation, at this row's exact grain. */
export const EXPECTED_COMMITTED: SQL = sql`
  COALESCE((
    SELECT SUM(res.reserved_qty::numeric)
      FROM inv_stock_reservations res
     WHERE res.org_id = sl.org_id
       AND res.product_variant_id = sl.product_variant_id
       AND res.location_id IS NOT DISTINCT FROM sl.location_id
       AND res.lot_id IS NOT DISTINCT FROM sl.lot_id
       AND res.serial_id IS NOT DISTINCT FROM sl.serial_id
       AND res.status = 'ACTIVE'
  ), 0)`;

/**
 * Picked and not yet shipped, less whatever a reservation already holds.
 *
 * The two buckets are disjoint by construction: `committed` covers units a
 * reservation is holding and `outgoing_qty` covers the rest of what is in the
 * tote, so availability subtracts each unit exactly once.
 *
 * Matched on lot and serial as well as location. The earlier version matched
 * `(variant, location)` only, deliberately, because that was the writer's own
 * `WHERE` — which meant the check was built to agree with the bug.
 *
 * Sales-order statuses are enumerated **positively** so a status added later
 * defaults to "no longer on the bench" rather than silently inflating the
 * bucket. `PARTIALLY_SHIPPED` belongs in the list: a half-shipped order still
 * has the rest of its units standing in a tote, and leaving it out made the
 * repair zero a correct figure and re-offer stock that had not left.
 */
export const EXPECTED_OUTGOING: SQL = sql`
  GREATEST(0, COALESCE((
    SELECT SUM(
             -- Shipped quantity lives on the sales-order line, not the pick
             -- line, so a partly shipped order is picked-minus-shipped rather
             -- than the whole pick. Clamped, because a line can be shipped from
             -- more than one pick.
             CASE WHEN pll.product_variant_id = sl.product_variant_id
                  THEN GREATEST(
                         0,
                         pll.quantity_picked::numeric
                           - LEAST(pll.quantity_picked::numeric, sol.quantity_shipped::numeric)
                       )
                  ELSE 0 END
             -- A substitute is what actually went in the tote. It is tracked on
             -- its own columns rather than folded into quantity_picked, so it
             -- needs its own term or swapping an item leaves those units
             -- sellable.
           + CASE WHEN pll.substitute_variant_id = sl.product_variant_id
                  THEN COALESCE(pll.substitute_quantity, 0)::numeric ELSE 0 END
           )
      FROM inv_pick_list_lines pll
      JOIN inv_pick_lists pl
        ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
      JOIN inv_so_lines sol
        ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
      JOIN inv_sales_orders so
        ON so.org_id = sol.org_id AND so.id = sol.so_id
     WHERE pll.org_id = sl.org_id
       AND (pll.product_variant_id = sl.product_variant_id
            OR pll.substitute_variant_id = sl.product_variant_id)
       AND pll.location_id IS NOT DISTINCT FROM sl.location_id
       AND pll.lot_id IS NOT DISTINCT FROM sl.lot_id
       AND pll.serial_id IS NOT DISTINCT FROM sl.serial_id
       AND pl.status <> 'CANCELLED'
       AND so.status IN (
         'DRAFT', 'CONFIRMED', 'PARTIALLY_RESERVED', 'RESERVED',
         'PICKED', 'PACKED', 'PARTIALLY_SHIPPED'
       )
  ), 0) - ${EXPECTED_COMMITTED})`;
