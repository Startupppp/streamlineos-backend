import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { rankBaselines, type BacktestResult } from "./backtest";

export interface DemandPoint {
  period: string;
  quantity: number;
}

export interface DemandBaselineReport {
  productVariantId: number;
  periods: number;
  history: DemandPoint[];
  /** Ordered best first. Empty when there is not enough history to judge. */
  ranked: BacktestResult[];
  /** The baseline to beat, or null when nothing could be measured. */
  champion: BacktestResult | null;
  insufficientReason?: string;
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
        ranked: [],
        champion: null,
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
        ranked: [],
        champion: null,
        insufficientReason: "No demand recorded in the window",
      };
    }

    const ranked = rankBaselines(series, { minTrain });
    return {
      productVariantId,
      periods: series.length,
      history,
      ranked,
      champion: ranked[0] ?? null,
    };
  }
}
