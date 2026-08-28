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
 * `alias` is the table alias the caller used, because these expressions appear
 * inside joins where `inv_stock_levels` is not the only table with an `on_hand`.
 */
export function availableQtySql(alias = "sl"): SQL {
  const a = sql.raw(alias);
  return sql`(
    ${a}.on_hand::numeric
    - ${a}.committed::numeric
    - COALESCE(${a}.blocked_qty, 0)::numeric
    - COALESCE(${a}.quality_hold_qty, 0)::numeric
    - COALESCE(${a}.outgoing_qty, 0)::numeric
  )`;
}

/** The same expression summed, for aggregates. */
export function availableQtySumSql(alias = "sl"): SQL {
  return sql`COALESCE(SUM(${availableQtySql(alias)}), 0)`;
}
