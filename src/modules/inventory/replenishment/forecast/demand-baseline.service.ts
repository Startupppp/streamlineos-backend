import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { rankBaselines, type BacktestResult } from "./backtest";
import {
  classifyDemand,
  detectSeasonality,
  type DemandClassification,
  type SeasonalityResult,
} from "./demand-shape";
import { cmpDec } from "../../stock-engine/decimal";
import { atLeastZero, fromExact } from "./exact";

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

export interface DemandBaselineReport {
  productVariantId: number;
  /** Null when the report covers the whole organisation. */
  warehouseId: number | null;
  periods: number;
  history: DemandPoint[];
  /** INV-302. What kind of demand this is, which constrains what is defensible. */
  classification: DemandClassification;
  seasonality: SeasonalityResult;
  /** Ordered best first. Empty when there is not enough history to judge. */
  ranked: BacktestResult[];
  /** Best among the methods this demand shape can justify. */
  champion: BacktestResult | null;
  /**
   * Best by error alone, ignoring shape. Reported separately when it differs,
   * because the disagreement is information rather than something to resolve
   * silently.
   */
  unrestrictedBest: BacktestResult | null;
  /** C1. How many periods closed with nothing on hand. */
  censoredPeriods: number;
  /** C1. Set when any period was censored; the demand figures understate reality. */
  stockoutCensored: boolean;
  /** The window the history actually covers, oldest and newest period. */
  coverage: { from: string; to: string };
  shapeNote?: string;
  insufficientReason?: string;
  censoringNote?: string;
}

/**
 * INV-302 — which methods this demand shape can justify.
 *
 * Ranking by error alone lets a method win while being structurally wrong. On
 * demand that sells 10 units five times a year, a flat 0.2-per-week forecast
 * has small error every single week and implies a reorder point that is
 * nonsense. Restricting the candidate set first, then ranking within it, keeps
 * the error measure honest about something it can actually measure.
 */
function methodsFor(
  classification: DemandClassification,
  seasonality: SeasonalityResult,
): (method: string) => boolean {
  const seasonal = seasonality.seasonLength !== null;
  return (method) => {
    // seasonalNaive on a series with no detected season propagates one
    // period's noise forward forever, so it is excluded rather than allowed to
    // win by luck.
    if (method.startsWith("seasonal_naive")) return seasonal;
    if (classification.category === "intermittent" || classification.category === "lumpy") {
      // A period average over gappy demand forecasts a fraction of a unit
      // every period: never right, never obviously wrong.
      return method === "croston" || method === "naive";
    }
    return method !== "croston";
  };
}

/**
 * INV-301 — demand history and the baseline it establishes.
 *
 * Demand is what left the building to a customer: SALE and RESERVATION_CONSUME.
 * Deliberately not every outbound movement -- a transfer to another warehouse,
 * a scrap and a quarantine all reduce stock without anybody having wanted the
 * product, and counting them as demand is how a forecast learns to reorder for
 * a warehouse move.
 *
 * Periods are dense: a week with no sales is a zero, not a gap. This is the
 * detail that decides whether the arithmetic is right at all, because a series
 * that silently omits its quiet weeks has a higher mean than the real one, and
 * every safety stock computed from it will be too large.
 *
 * C1 added two things to that. The extraction takes a **warehouse**, because an
 * org-wide series answers a question nobody asked when one site is short and
 * another is long. And each period carries whether it was **stockout-censored**,
 * because a zero that means "nobody wanted any" and a zero that means "we had
 * none to sell" are the same number and opposite facts.
 */
@Injectable()
export class DemandBaselineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * C1 — which warehouse a forecast request is entitled to ask about.
   *
   * Every forecast surface funnels through here so the gate cannot be applied
   * in four places and forgotten in a fifth. Three cases, and the interesting
   * one is the third:
   *
   *   * A named warehouse is checked against the caller's assignments.
   *     `assertWarehouseVisible` answers a warehouse they do not hold with a
   *     404, not a 403, because a 403 on somebody else's id confirms it exists.
   *   * No warehouse named, and the caller holds the org-wide scope permission:
   *     the whole organisation, which is what the surface has always answered.
   *   * No warehouse named, and the caller is restricted to specific
   *     warehouses. An org-wide forecast would aggregate demand from sites they
   *     cannot see, so it is refused — with one exception: an operator assigned
   *     to exactly one warehouse has named it unambiguously by having only one,
   *     and making them type it out buys nothing. Two or more is a real choice
   *     and they have to make it.
   */
  async scopeFor(
    orgId: string,
    userId: string,
    requested?: number | null,
  ): Promise<number | null> {
    if (requested != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, requested);
      return requested;
    }
    const scope = await this.warehouseScope.resolve(orgId, userId);
    if (scope === null) return null;
    if (scope.length === 1) return scope[0]!;
    throw new ForbiddenException(
      scope.length === 0
        ? "You are not assigned to any warehouse, so there is no demand history you may forecast."
        : "Your inventory access is limited to specific warehouses. Name the warehouse to forecast; an organisation-wide forecast would include sites you cannot see.",
    );
  }

  /** Restricts a transactions/stock-levels alias to one warehouse via its location. */
  private warehouseFilter(alias: string, orgId: string, warehouseId: number | null): SQL {
    if (warehouseId === null) return sql`TRUE`;
    const a = sql.raw(alias);
    return sql`EXISTS (
      SELECT 1 FROM inv_locations wh_loc
      WHERE wh_loc.id = ${a}.location_id
        AND wh_loc.org_id = ${orgId}
        AND wh_loc.warehouse_id = ${warehouseId}
    )`;
  }

  async history(
    orgId: string,
    productVariantId: number,
    options: { weeks?: number } & DemandScope = {},
  ): Promise<DemandPoint[]> {
    const weeks = Math.min(options.weeks ?? 52, 260);
    const warehouseId = options.warehouseId ?? null;
    const txnScope = this.warehouseFilter("t", orgId, warehouseId);
    const levelScope = this.warehouseFilter("sl", orgId, warehouseId);

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
    const rows = await this.db.execute<{
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

  /**
   * Which baseline currently describes this SKU best.
   *
   * Refuses to answer on thin history rather than reporting a champion chosen
   * from noise. "Not enough data" is a real answer and the one the phase asks
   * for; a confident forecast from six weeks of a new product is how a
   * replenishment engine orders a year's stock of something nobody has bought
   * twice.
   */
  async baseline(
    orgId: string,
    productVariantId: number,
    options: { weeks?: number; minTrain?: number } & DemandScope = {},
  ): Promise<DemandBaselineReport> {
    const warehouseId = options.warehouseId ?? null;
    const history = await this.history(orgId, productVariantId, options);
    const series = demandSeries(history);
    const minTrain = options.minTrain ?? 8;

    const censoredPeriods = history.filter((p) => p.stockoutCensored).length;
    // Stated as a share rather than a count, because six censored weeks in
    // twelve and six in two hundred are different situations.
    const censoringNote =
      censoredPeriods === 0
        ? undefined
        : `${censoredPeriods} of ${history.length} periods closed with nothing on hand. Demand in those periods is a lower bound — a customer who found an empty shelf left no record — so every figure derived from this history understates real demand.`;

    const base = {
      productVariantId,
      warehouseId,
      periods: series.length,
      history,
      censoredPeriods,
      stockoutCensored: censoredPeriods > 0,
      censoringNote,
      coverage: {
        from: history[0]?.period ?? "",
        to: history[history.length - 1]?.period ?? "",
      },
    };

    if (series.length < minTrain + 4) {
      return {
        ...base,
        classification: classifyDemand(series),
        seasonality: detectSeasonality(series),
        ranked: [],
        champion: null,
        unrestrictedBest: null,
        insufficientReason: `Needs at least ${minTrain + 4} periods of history to judge a baseline; has ${series.length}`,
      };
    }

    // A series that has never moved has no forecast worth ranking, and every
    // method would tie at zero error, which reads as a confident result.
    if (series.every((value) => value === 0)) {
      return {
        ...base,
        classification: classifyDemand(series),
        seasonality: detectSeasonality(series),
        ranked: [],
        champion: null,
        unrestrictedBest: null,
        insufficientReason: "No demand recorded in the window",
      };
    }

    const classification = classifyDemand(series);
    const seasonality = detectSeasonality(series);
    const ranked = rankBaselines(series, { minTrain });

    const allowed = methodsFor(classification, seasonality);
    const eligible = ranked.filter((r) => allowed(r.method));
    const champion = eligible[0] ?? ranked[0] ?? null;
    const unrestrictedBest = ranked[0] ?? null;

    return {
      ...base,
      classification,
      seasonality,
      ranked,
      champion,
      unrestrictedBest,
      shapeNote:
        champion && unrestrictedBest && champion.method !== unrestrictedBest.method
          ? `${unrestrictedBest.method} scored lower error, but ${classification.category} demand cannot justify it; ${champion.method} was chosen instead.`
          : undefined,
    };
  }
}
