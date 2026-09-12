import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { ForecastDriftService, type DriftReport } from "./forecast-drift.service";
import {
  ForecastPersistenceService,
  type ForecastVersion,
} from "./forecast-persistence.service";
import { DemandBaselineService } from "./demand-baseline.service";
import {
  DEFAULT_MAE_RATIO_THRESHOLD,
  ageInDays,
  breachesMaeThreshold,
  isStaleVersion,
} from "./drift-thresholds";

export interface DriftWatchRow {
  forecastId: number;
  productVariantId: number;
  variantSku: string;
  productName: string;
  warehouseId: number | null;
  warehouseName: string | null;
  method: string | null;
  generatedAt: string;
  /** Backtest error of the stored champion. Decimal strings, as stored. */
  mae: string | null;
  rmse: string | null;
  bias: string | null;
  mase: string | null;
  demandMean: string;
  /** MAE relative to mean weekly demand. Null when the SKU sells nothing. */
  maeRatio: string | null;
  breachesThreshold: boolean;
  /** The version has outlived the horizon it claims to speak for. */
  stale: boolean;
  ageDays: number;
  coverage: {
    periods: number;
    from: string;
    to: string;
    censoredPeriods: number;
    stockoutCensored: boolean;
  };
  applicable: boolean;
  refusalReason: string | null;
  /** How many stored versions stand behind this number. */
  storedVersions: number;
}

export interface DriftSummary {
  tracked: number;
  breaching: number;
  stale: number;
  refused: number;
  /** Forecast coverage of the catalogue. */
  coverage: { variantsForecast: number; variantsTotal: number; percent: string };
  /** How often a proposal was acted on, and how often a refusal was overridden. */
  proposals: {
    total: number;
    accepted: number;
    acceptedPercent: string;
    refusals: number;
    overridden: number;
    overriddenPercent: string;
  };
}

export interface DriftDetail {
  report: DriftReport;
  /** The persisted rows the number came from — the evidence link's destination. */
  evidence: {
    productVariantId: number;
    warehouseId: number | null;
    totalVersions: number;
    versions: ForecastVersion[];
  };
}

/**
 * C7 — noticing that a forecast has stopped working, without touching it.
 *
 * `ForecastDriftService` already answers the hard question for one SKU: split
 * the history, backtest both halves, compare. What it had no way to do was be
 * *found* — there was no HTTP surface and no list, so the only SKU anybody ever
 * checked was one they already suspected. This is the watchlist over the stored
 * versions, so the SKU whose error has blown out appears without being asked
 * about, with a link to the rows the number came from.
 *
 * **Nothing here writes.** Every method issues SELECTs and nothing else: no
 * insert, no update, no regeneration, no "refresh the forecast while we are
 * here". A monitor that changes the thing it monitors destroys the evidence it
 * exists to preserve, and the next reader cannot tell whether the number moved
 * because demand moved or because looking at it moved it. `drift-monitor.spec.ts`
 * pins that by asserting the service never reaches for a writing method.
 *
 * The two rates are defined narrowly, and the definitions are worth stating
 * because a looser one would be a number that means nothing. A proposal is
 * **accepted** when a purchase order for that variant and site was raised within
 * the horizon the version claims to speak for. A refusal is **overridden** when
 * one was raised anyway after the engine declined to commit to a quantity —
 * which is a real, deliberate act by a buyer, not an inference about intent.
 */
@Injectable()
export class DriftMonitorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly drift: ForecastDriftService,
    private readonly versions: ForecastPersistenceService,
    private readonly baselines: DemandBaselineService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async watchlist(
    orgId: string,
    userId: string,
    query: {
      warehouseId?: number;
      maeRatioThreshold?: number;
      breachingOnly?: boolean;
      page: number;
      limit: number;
    },
  ): Promise<{
    items: DriftWatchRow[];
    total: number;
    page: number;
    totalPages: number;
    threshold: number;
    summary: DriftSummary;
  }> {
    const threshold = query.maeRatioThreshold ?? DEFAULT_MAE_RATIO_THRESHOLD;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const emptySummary: DriftSummary = {
      tracked: 0,
      breaching: 0,
      stale: 0,
      refused: 0,
      coverage: { variantsForecast: 0, variantsTotal: 0, percent: "0.00" },
      proposals: {
        total: 0,
        accepted: 0,
        acceptedPercent: "0.00",
        refusals: 0,
        overridden: 0,
        overriddenPercent: "0.00",
      },
    };
    if (scope.isEmpty) {
      return {
        items: [],
        total: 0,
        page: query.page,
        totalPages: 0,
        threshold,
        summary: emptySummary,
      };
    }

    const warehouseFilter =
      query.warehouseId === undefined ? sql`TRUE` : sql`f.warehouse_id = ${query.warehouseId}`;

    // The newest stored version per (variant, site). A watchlist over every
    // version would rank the same SKU thirty times and bury the rest.
    const latest = sql`
      SELECT DISTINCT ON (f.product_variant_id, f.warehouse_id) f.id
      FROM inv_demand_forecasts f
      WHERE f.org_id = ${orgId}
        AND ${warehouseFilter}
        AND ${scope.warehouse(sql`f.warehouse_id`)}
      ORDER BY f.product_variant_id, f.warehouse_id, f.generated_at DESC, f.id DESC
    `;

    const breachFilter =
      query.breachingOnly === true
        ? sql`AND scored.mae_ratio IS NOT NULL AND scored.mae_ratio >= ${threshold}`
        : sql``;

    const scored = sql`
      SELECT f.id,
             f.product_variant_id,
             f.warehouse_id,
             f.method,
             f.mae,
             f.rmse,
             f.bias,
             f.mase,
             f.demand_mean,
             f.periods,
             f.coverage_from,
             f.coverage_to,
             f.censored_periods,
             f.stockout_censored,
             f.horizon_weeks,
             f.applicable,
             f.refusal_reason,
             f.generated_at,
             CASE
               WHEN f.mae IS NULL OR f.demand_mean::numeric <= 0 THEN NULL
               ELSE round(f.mae::numeric / f.demand_mean::numeric, 4)
             END AS mae_ratio
      FROM (${latest}) latest
      JOIN inv_demand_forecasts f ON f.id = latest.id
    `;

    const [countRow] = await this.db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total FROM (${scored}) scored WHERE TRUE ${breachFilter}
    `);
    const total = Number(countRow?.total ?? 0);

    const rows =
      total === 0
        ? []
        : await this.db.execute<DriftRow>(sql`
            SELECT scored.*,
                   pv.sku AS variant_sku,
                   p.name AS product_name,
                   w.name AS warehouse_name,
                   (
                     SELECT count(*)::int
                     FROM inv_demand_forecasts h
                     WHERE h.org_id = ${orgId}
                       AND h.product_variant_id = scored.product_variant_id
                       AND h.warehouse_id IS NOT DISTINCT FROM scored.warehouse_id
                   ) AS stored_versions
            FROM (${scored}) scored
            JOIN inv_product_variants pv
              ON pv.org_id = ${orgId} AND pv.id = scored.product_variant_id
            JOIN inv_products p ON p.org_id = pv.org_id AND p.id = pv.product_id
            LEFT JOIN inv_warehouses w
              ON w.org_id = ${orgId} AND w.id = scored.warehouse_id
            WHERE TRUE ${breachFilter}
            ORDER BY scored.mae_ratio DESC NULLS LAST, scored.id DESC
            LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
          `);

    return {
      items: rows.map((row) => toWatchRow(row, threshold)),
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
      threshold,
      summary: await this.summary(orgId, latest, threshold),
    };
  }

  /**
   * The deep report for one SKU, beside the rows it was computed from.
   *
   * The evidence is the point. A drift status with no way to reach the stored
   * versions behind it is an assertion, and an assertion about a forecast is
   * what nobody trusts enough to act on.
   */
  async detail(
    orgId: string,
    userId: string,
    productVariantId: number,
    query: { warehouseId?: number; weeks?: number },
  ): Promise<DriftDetail> {
    const warehouseId = await this.baselines.scopeFor(orgId, userId, query.warehouseId ?? null);
    const [report, stored] = await Promise.all([
      this.drift.drift(orgId, productVariantId, {
        warehouseId,
        ...(query.weeks === undefined ? {} : { weeks: query.weeks }),
      }),
      this.versions.versions(orgId, productVariantId, warehouseId, { page: 1, limit: 10 }),
    ]);

    return {
      report,
      evidence: {
        productVariantId,
        warehouseId,
        totalVersions: stored.total,
        versions: stored.items,
      },
    };
  }

  /**
   * Coverage, staleness and the two rates, org-wide.
   *
   * A watchlist without coverage flatters itself: five SKUs all healthy reads as
   * a healthy forecast until you notice the catalogue has four hundred.
   */
  private async summary(
    orgId: string,
    latest: ReturnType<typeof sql>,
    threshold: number,
  ): Promise<DriftSummary> {
    const [row] = await this.db.execute<{
      tracked: number;
      breaching: number;
      stale: number;
      refused: number;
      proposals: number;
      accepted: number;
      refusals: number;
      overridden: number;
      variants_forecast: number;
      variants_total: number;
    }>(sql`
      WITH latest AS (${latest}),
      versions AS (
        SELECT f.*,
               (
                 f.mae IS NOT NULL
                 AND f.demand_mean::numeric > 0
                 AND (f.mae::numeric / f.demand_mean::numeric) >= ${threshold}
               ) AS breaches,
               (now() > f.generated_at + (f.horizon_weeks * INTERVAL '7 days')) AS stale
        FROM latest
        JOIN inv_demand_forecasts f ON f.id = latest.id
      ),
      acted AS (
        SELECT v.id,
               v.applicable,
               v.breaches,
               v.stale,
               EXISTS (
                 SELECT 1
                 FROM inv_po_lines pl
                 JOIN inv_purchase_orders po
                   ON po.org_id = pl.org_id AND po.id = pl.po_id
                 WHERE pl.org_id = ${orgId}
                   AND pl.product_variant_id = v.product_variant_id
                   AND po.warehouse_id IS NOT DISTINCT FROM v.warehouse_id
                   AND po.created_at >= v.generated_at
                   AND po.created_at < v.generated_at + (v.horizon_weeks * INTERVAL '7 days')
               ) AS ordered
        FROM versions v
      )
      SELECT count(*)::int AS tracked,
             count(*) FILTER (WHERE breaches)::int AS breaching,
             count(*) FILTER (WHERE stale)::int AS stale,
             count(*) FILTER (WHERE NOT applicable)::int AS refused,
             count(*) FILTER (WHERE applicable)::int AS proposals,
             count(*) FILTER (WHERE applicable AND ordered)::int AS accepted,
             count(*) FILTER (WHERE NOT applicable)::int AS refusals,
             count(*) FILTER (WHERE NOT applicable AND ordered)::int AS overridden,
             (
               SELECT count(DISTINCT product_variant_id)::int
               FROM inv_demand_forecasts
               WHERE org_id = ${orgId}
             ) AS variants_forecast,
             (
               SELECT count(*)::int
               FROM inv_product_variants pv
               JOIN inv_products p ON p.org_id = pv.org_id AND p.id = pv.product_id
               WHERE pv.org_id = ${orgId}
                 AND pv.deleted_at IS NULL
                 AND p.deleted_at IS NULL
             ) AS variants_total
      FROM acted
    `);

    const tracked = Number(row?.tracked ?? 0);
    const proposals = Number(row?.proposals ?? 0);
    const accepted = Number(row?.accepted ?? 0);
    const refusals = Number(row?.refusals ?? 0);
    const overridden = Number(row?.overridden ?? 0);
    const variantsForecast = Number(row?.variants_forecast ?? 0);
    const variantsTotal = Number(row?.variants_total ?? 0);

    return {
      tracked,
      breaching: Number(row?.breaching ?? 0),
      stale: Number(row?.stale ?? 0),
      refused: Number(row?.refused ?? 0),
      coverage: {
        variantsForecast,
        variantsTotal,
        percent: percent(variantsForecast, variantsTotal),
      },
      proposals: {
        total: proposals,
        accepted,
        acceptedPercent: percent(accepted, proposals),
        refusals,
        overridden,
        overriddenPercent: percent(overridden, refusals),
      },
    };
  }
}

interface DriftRow extends Record<string, unknown> {
  id: number;
  product_variant_id: number;
  warehouse_id: number | null;
  warehouse_name: string | null;
  variant_sku: string;
  product_name: string;
  method: string | null;
  mae: string | null;
  rmse: string | null;
  bias: string | null;
  mase: string | null;
  demand_mean: string;
  mae_ratio: string | null;
  horizon_weeks: number;
  periods: number;
  coverage_from: string;
  coverage_to: string;
  censored_periods: number;
  stockout_censored: boolean;
  applicable: boolean;
  refusal_reason: string | null;
  generated_at: Date;
  stored_versions: number;
}

function toWatchRow(row: DriftRow, threshold: number): DriftWatchRow {
  const generatedAt = new Date(row.generated_at);
  return {
    forecastId: Number(row.id),
    productVariantId: Number(row.product_variant_id),
    variantSku: row.variant_sku,
    productName: row.product_name,
    warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
    warehouseName: row.warehouse_name,
    method: row.method,
    generatedAt: generatedAt.toISOString(),
    mae: row.mae,
    rmse: row.rmse,
    bias: row.bias,
    mase: row.mase,
    demandMean: row.demand_mean,
    maeRatio: row.mae_ratio,
    breachesThreshold: breachesMaeThreshold(row.mae_ratio, threshold),
    stale: isStaleVersion(generatedAt, Number(row.horizon_weeks)),
    ageDays: ageInDays(generatedAt),
    coverage: {
      periods: Number(row.periods),
      from: row.coverage_from,
      to: row.coverage_to,
      censoredPeriods: Number(row.censored_periods),
      stockoutCensored: row.stockout_censored === true,
    },
    applicable: row.applicable === true,
    refusalReason: row.refusal_reason,
    storedVersions: Number(row.stored_versions ?? 0),
  };
}

/** Rates are reported to two places, and a zero denominator is 0, never NaN. */
function percent(part: number, whole: number): string {
  if (whole <= 0) return "0.00";
  return ((part / whole) * 100).toFixed(2);
}
