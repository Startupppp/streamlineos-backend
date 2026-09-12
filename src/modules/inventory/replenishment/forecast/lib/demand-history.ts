import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../../../db/drizzle.module";
import { cmpDec } from "../../../stock-engine/decimal";
import { atLeastZero, fromExact } from "../exact";

/**
 * INV-301's extraction half — the weekly demand series off the ledger — lifted
 * out of `demand-baseline.service.ts` unchanged.
 *
 * The seam is the one that file's own doc on `demandSeries` names: "the single
 * crossing from exact quantities into the statistical estimators". Everything
 * here is on the exact side. `demandHistory` is the only SQL the service ran of
 * its own, and it returns decimal strings summed from `numeric(18,4)`
 * movements; `demandSeries` is the one place those become floats. Everything
 * left in the service is on the other side: `baseline` classifies, detects
 * seasonality and ranks estimators over `number[]`, and never issues a query.
 * `scopeFor`, the permission gate, stays there too — `demandHistory` takes a
 * warehouse id the caller has ALREADY validated through it (see `DemandScope`)
 * and only applies it as a filter, so no gate moves.
 */
export interface DemandPoint {
  period: string;
  /**
   * C1. The exact ledger figure, as a decimal string. This is a quantity, not a
   * statistic: it is summed from `numeric(18,4)` movements and it is shown to a
   * human, so it never passes through a float. `demandSeries` is the one place
   * it becomes one, for the estimators that genuinely need floats.
   */
  quantity: string;
  /** Reconstructed on-hand at the close of the period, across the scope asked for. */
  closingOnHand: string;
  /**
   * C1. This period closed with nothing on hand, so the demand recorded against
   * it is a *lower bound* rather than a measurement — anybody who wanted the
   * product and found none left no trace in the ledger. A forecast fitted to
   * censored periods learns the stockout, not the demand, and then buys too
   * little forever.
   */
  stockoutCensored: boolean;
}

/**
 * The single crossing from exact quantities into the statistical estimators.
 * Every float in `baselines.ts`, `accuracy.ts`, `demand-shape.ts` and
 * `safety-stock.ts` is traceable to this call. See `exact.ts` for why the line
 * is here and not somewhere else.
 */
export function demandSeries(history: readonly DemandPoint[]): number[] {
  return history.map((point) => Math.max(0, fromExact(point.quantity)));
}

export interface DemandScope {
  /**
   * C1. `null` (or absent) means the whole organisation. A number restricts
   * every figure — demand, the on-hand walk behind the censoring flag — to one
   * warehouse.
   *
   * This exists because a variant is routinely short in one warehouse and long
   * in another, and an org-wide answer is the average of the two: it proposes
   * nothing for the site that is about to stock out and nothing for the site
   * that is drowning. The caller is responsible for having checked that the
   * warehouse is visible to the user (`WarehouseScopeService`).
   */
  warehouseId?: number | null;
}

/** Restricts a transactions/stock-levels alias to one warehouse via its location. */
function warehouseFilter(alias: string, orgId: string, warehouseId: number | null): SQL {
  if (warehouseId === null) return sql`TRUE`;
  const a = sql.raw(alias);
  return sql`EXISTS (
    SELECT 1 FROM inv_locations wh_loc
    WHERE wh_loc.id = ${a}.location_id
      AND wh_loc.org_id = ${orgId}
      AND wh_loc.warehouse_id = ${warehouseId}
  )`;
}

export async function demandHistory(
  db: Db,
  orgId: string,
  productVariantId: number,
  options: { weeks?: number } & DemandScope = {},
): Promise<DemandPoint[]> {
  const weeks = Math.min(options.weeks ?? 52, 260);
  const warehouseId = options.warehouseId ?? null;
  const txnScope = warehouseFilter("t", orgId, warehouseId);
  const levelScope = warehouseFilter("sl", orgId, warehouseId);

  // Three things come back per period and they are computed in one round trip
  // because they have to agree with each other:
  //
  //   `demand`  — what customers took, on the dense weekly spine.
  //   `delta`   — every ON_HAND movement, used only to walk the balance back.
  //   `closing` — on-hand at the close of that period.
  //
  // The balance is walked *backwards* from the live position rather than
  // forwards from a reconstructed opening, because `inv_stock_levels` is the
  // number the warehouse agrees with today; a forward walk would need an
  // opening balance that only the ledger can supply, and any gap in it would
  // then be carried through the whole window instead of only past it.
  //
  // `future` covers movements posted beyond the end of the window — a
  // forward-dated receipt is legal and would otherwise be silently attributed
  // to the last period, which is exactly the sort of off-by-one that reads as
  // a plausible stockout.
  const rows = await db.execute<{
    period: string;
    quantity: string;
    closing_on_hand: string;
  }>(sql`
    WITH spine AS (
      SELECT generate_series(
        date_trunc('week', CURRENT_DATE) - (${weeks - 1} || ' weeks')::interval,
        date_trunc('week', CURRENT_DATE),
        '1 week'
      )::date AS period
    ),
    bounds AS (
      SELECT MIN(period) AS first_period, MAX(period) AS last_period FROM spine
    ),
    moves AS (
      SELECT date_trunc('week', t.posting_date)::date AS period,
             COALESCE(SUM(-t.quantity_change) FILTER (
               WHERE t.transaction_type IN ('SALE', 'RESERVATION_CONSUME')
                 AND t.quantity_change < 0
             ), 0)::numeric AS demand,
             COALESCE(SUM(t.quantity_change) FILTER (
               WHERE t.quantity_bucket = 'ON_HAND'
             ), 0)::numeric AS delta
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId}
        AND t.product_variant_id = ${productVariantId}
        AND t.posting_date IS NOT NULL
        AND t.posting_date >= (SELECT first_period FROM bounds)
        AND t.posting_date <= (SELECT last_period + 6 FROM bounds)
        AND ${txnScope}
      GROUP BY 1
    ),
    future AS (
      SELECT COALESCE(SUM(t.quantity_change), 0)::numeric AS delta
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId}
        AND t.product_variant_id = ${productVariantId}
        AND t.quantity_bucket = 'ON_HAND'
        AND t.posting_date > (SELECT last_period + 6 FROM bounds)
        AND ${txnScope}
    ),
    live AS (
      SELECT COALESCE(SUM(sl.on_hand), 0)::numeric AS on_hand
      FROM inv_stock_levels sl
      WHERE sl.org_id = ${orgId}
        AND sl.product_variant_id = ${productVariantId}
        AND ${levelScope}
    )
    SELECT s.period::text AS period,
           COALESCE(m.demand, 0)::text AS quantity,
           (
             (SELECT on_hand FROM live)
             - (SELECT delta FROM future)
             - COALESCE(SUM(COALESCE(m.delta, 0)) OVER (
                 ORDER BY s.period DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ), 0)
           )::text AS closing_on_hand
    FROM spine s
    LEFT JOIN moves m ON m.period = s.period
    ORDER BY s.period
  `);

  return rows.map((row) => ({
    period: row.period,
    // Clamped at zero: a negative demand would be a returned sale posted as a
    // negative SALE, which is a correction rather than negative want. The
    // comparison is `cmpDec`, not `<` — these are exact quantities.
    quantity: atLeastZero(row.quantity),
    closingOnHand: row.closing_on_hand,
    // `<= 0` rather than `= 0`: a reconstructed balance that has gone negative
    // means the ledger and `inv_stock_levels` disagree, and in either reading
    // there was nothing to sell.
    stockoutCensored: cmpDec(row.closing_on_hand, "0") <= 0,
  }));
}
