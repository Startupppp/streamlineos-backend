import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { rankBaselines, type BacktestResult } from "./backtest";
import {
  classifyDemand,
  detectSeasonality,
  type DemandClassification,
  type SeasonalityResult,
} from "./demand-shape";

export interface DemandPoint {
  period: string;
  quantity: number;
}

export interface DemandBaselineReport {
  productVariantId: number;
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
  shapeNote?: string;
  insufficientReason?: string;
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
 */
@Injectable()
export class DemandBaselineService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async history(
    orgId: string,
    productVariantId: number,
    options: { weeks?: number } = {},
  ): Promise<DemandPoint[]> {
    const weeks = Math.min(options.weeks ?? 52, 260);

    // generate_series builds the dense spine, and the ledger is joined onto it.
    // Aggregating the other way round would drop every quiet week.
    const rows = await this.db.execute<{ period: string; quantity: string }>(sql`
      WITH spine AS (
        SELECT generate_series(
          date_trunc('week', CURRENT_DATE) - (${weeks - 1} || ' weeks')::interval,
          date_trunc('week', CURRENT_DATE),
          '1 week'
        )::date AS period
      )
      SELECT s.period::text AS period,
             COALESCE(SUM(-t.quantity_change), 0)::text AS quantity
      FROM spine s
      LEFT JOIN inv_stock_transactions t
        ON t.org_id = ${orgId}
       AND t.product_variant_id = ${productVariantId}
       AND t.transaction_type IN ('SALE', 'RESERVATION_CONSUME')
       AND t.quantity_change < 0
       AND date_trunc('week', t.posting_date)::date = s.period
      GROUP BY s.period
      ORDER BY s.period
    `);

    return rows.map((row) => ({
      period: row.period,
      quantity: Math.max(0, Number(row.quantity)),
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
    options: { weeks?: number; minTrain?: number } = {},
  ): Promise<DemandBaselineReport> {
    const history = await this.history(orgId, productVariantId, options);
    const series = history.map((p) => p.quantity);
    const minTrain = options.minTrain ?? 8;

    if (series.length < minTrain + 4) {
      return {
        productVariantId,
        periods: series.length,
        history,
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
        productVariantId,
        periods: series.length,
        history,
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
      productVariantId,
      periods: series.length,
      history,
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
