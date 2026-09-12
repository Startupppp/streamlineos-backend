import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
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
import {
  demandHistory,
  demandSeries,
  type DemandPoint,
  type DemandScope,
} from "./lib/demand-history";

/**
 * The extraction half — the weekly ledger walk and its one exact-to-float
 * crossing — is in `lib/demand-history.ts`. Re-exported so the forecast
 * services that import `demandSeries` and `DemandScope` from here keep
 * resolving.
 */
export { demandSeries };
export type { DemandPoint, DemandScope };

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

  /**
   * INV-301 — the dense weekly demand series, with the on-hand walk behind each
   * period's censoring flag. See `lib/demand-history.ts`.
   */
  history(
    orgId: string,
    productVariantId: number,
    options: { weeks?: number } & DemandScope = {},
  ): Promise<DemandPoint[]> {
    return demandHistory(this.db, orgId, productVariantId, options);
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
