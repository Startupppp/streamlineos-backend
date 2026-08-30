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
 * NEO-11 added a second gate of the same kind: *whose* the stock is. Consigned
 * goods are on hand and are not ours, and only `OWNED` may be promised. It sits
 * beside the transit gate rather than in the five callers, for exactly the reason
 * that one does.
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
    -- NEO-11. Consigned stock is standing in our building and belongs to
    -- somebody else until it is sold, so it is never available to promise. The
    -- gate is here, in the canonical expression, for the same reason the transit
    -- gate is: a term each of five call sites has to remember is a term one of
    -- them will forget, and forgetting this one offers a supplier's goods for
    -- sale.
    OR ${a}.ownership <> 'OWNED'
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

/**
 * NEO-1 — the channel-pool claim on a variant, as SQL.
 *
 * Deliberately **not** folded into `availableQtySql`. That expression is
 * evaluated per stock-level row and a pool is a claim on a variant, so folding
 * it in would subtract the same six units once for every bin the SKU sits in.
 * It is a separate aggregate, subtracted once, and the composition is
 * `netAvailableQty` in `decimal.ts` — the same pairing as `availableQty` and
 * `availableQtySql`, and the reason both live in the two canonical files.
 *
 * `warehouseId` null means "org-wide question": every pool for the variant
 * counts. A warehouse-scoped question counts the pools pinned to that warehouse
 * plus the unpinned ones, which over-subtracts across several warehouses and
 * says so in `channel-pools.ts`.
 *
 * `excludeChannelId` is what lets a channel see its own stock: an order placed
 * on Blinkit is checked against everyone else's claim, not against Blinkit's.
 */
export function channelReservedQtySql(params: {
  orgId: string;
  productVariantId: number;
  warehouseId?: number | null;
  excludeChannelId?: number | null;
}): SQL {
  const warehouseGate =
    params.warehouseId == null
      ? sql`TRUE`
      : sql`(cp.warehouse_id IS NULL OR cp.warehouse_id = ${params.warehouseId})`;
  const channelGate =
    params.excludeChannelId == null
      ? sql`TRUE`
      : sql`cp.channel_id <> ${params.excludeChannelId}`;

  return sql`(
    SELECT COALESCE(SUM(cp.reserved_qty), 0)::numeric
    FROM inv_channel_pools cp
    WHERE cp.org_id = ${params.orgId}
      AND cp.product_variant_id = ${params.productVariantId}
      AND ${warehouseGate}
      AND ${channelGate}
  )`;
}
