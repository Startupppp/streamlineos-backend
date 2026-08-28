import { sql, type SQL } from "drizzle-orm";

/**
 * A1 — the SQL half of `availableQty`, so the two cannot drift.
 *
 * Every list, aggregate and popover that needs availability calls this rather
 * than writing the subtraction out. Six hand-written copies existed before, and
 * none of them subtracted `outgoing_qty` — the term that means "picked and
 * standing on the packing bench". A copy of a formula stays correct only until
 * somebody adds a term to the original.
 *
 * A2 added a term of a different kind: *where* the stock is standing. Goods in
 * transit between two warehouses are parked at that warehouse's `TRANSIT`
 * location, which is flagged `is_sellable = false`. They are on hand — org-wide
 * on-hand and valuation are conserved for the whole journey, which is the point
 * — but they are in a van, and a van cannot be picked from. Without this gate
 * every ATP figure in the product would cheerfully offer them for sale.
 *
 * The gate is a correlated `EXISTS` on `inv_locations` by primary key rather
 * than a join, deliberately: an extra join argument is something each of the
 * five call sites has to remember to pass, and forgetting it is silent — which
 * is exactly the drift A1 collapsed eight copies of this formula to remove. A
 * primary-key probe per row is cheap and, more importantly, unforgettable.
 *
 * `is_sellable` is nullable with a `true` default, so only an explicit `FALSE`
 * withdraws stock from availability: `IS NOT FALSE` is sellable. A row whose
 * location cannot be read at all (RLS, or a location that has gone) is treated
 * as sellable, matching that default rather than silently zeroing a warehouse.
 *
 * `alias` is the table alias the caller used, because these expressions appear
 * inside joins where `inv_stock_levels` is not the only table with an `on_hand`.
 */
export function availableQtySql(alias = "sl"): SQL {
  const a = sql.raw(alias);
  return sql`(
    CASE WHEN EXISTS (
      SELECT 1 FROM inv_locations avail_sellable_loc
      WHERE avail_sellable_loc.id = ${a}.location_id
        AND avail_sellable_loc.is_sellable IS FALSE
    )
    THEN 0::numeric
    ELSE (
      ${a}.on_hand::numeric
      - ${a}.committed::numeric
      - COALESCE(${a}.blocked_qty, 0)::numeric
      - COALESCE(${a}.quality_hold_qty, 0)::numeric
      - COALESCE(${a}.outgoing_qty, 0)::numeric
    )
    END
  )`;
}

/** The same expression summed, for aggregates. */
export function availableQtySumSql(alias = "sl"): SQL {
  return sql`COALESCE(SUM(${availableQtySql(alias)}), 0)`;
}
