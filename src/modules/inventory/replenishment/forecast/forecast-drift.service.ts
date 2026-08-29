import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { DemandBaselineService, demandSeries, type DemandScope } from "./demand-baseline.service";
import { BASELINES } from "./baselines";
import { backtest } from "./backtest";
import type { AccuracyMetrics } from "./accuracy";

export interface DriftReport {
  productVariantId: number;
  /** Null when the report covers the whole organisation. */
  warehouseId: number | null;
  method: string | null;
  earlier: AccuracyMetrics | null;
  recent: AccuracyMetrics | null;
  /** Ratio of recent MAE to earlier MAE. Above 1 means it got worse. */
  maeRatio: number | null;
  status: "stable" | "degrading" | "improving" | "insufficient_data";
  /** Whether the champion method has changed since the earlier window. */
  championChanged: boolean;
  previousChampion?: string;
  findings: string[];
}

/**
 * INV-310 — noticing when a forecast stops working.
 *
 * A forecasting system quietly degrades. Demand shifts, a product's season
 * moves, a competitor opens, and the method that was chosen eighteen months ago
 * keeps producing numbers with exactly the same confidence. Nobody looks,
 * because nothing broke.
 *
 * What this does is deliberately modest, and worth being explicit about: it
 * splits the history in half, backtests the same method on each half, and
 * compares. **That is a heuristic, not a hypothesis test.** With a handful of
 * periods per half the difference between the two numbers is mostly noise, so
 * the report refuses to call drift below a minimum sample and states the
 * comparison it made rather than just its conclusion. A drift monitor that
 * cries wolf is turned off within a month, and then the real drift goes
 * unnoticed too.
 */
@Injectable()
export class ForecastDriftService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly baselines: DemandBaselineService,
  ) {}

  /** Enough periods per half that a difference is worth reading. */
  private static readonly MIN_PERIODS_PER_HALF = 12;
  /** Recent error this many times the earlier error counts as degradation. */
  private static readonly DEGRADATION_RATIO = 1.5;
  private static readonly IMPROVEMENT_RATIO = 0.67;

  async drift(
    orgId: string,
    productVariantId: number,
    options: { weeks?: number } & DemandScope = {},
  ): Promise<DriftReport> {
    const weeks = options.weeks ?? 52;
    const warehouseId = options.warehouseId ?? null;
    const report = await this.baselines.baseline(orgId, productVariantId, {
      weeks,
      warehouseId,
    });
    // C1. The estimators want floats; the ledger figures behind them are exact.
    // `demandSeries` is the only crossing.
    const series = demandSeries(report.history);

    const findings: string[] = [];

    if (
      series.length <
      ForecastDriftService.MIN_PERIODS_PER_HALF * 2
    ) {
      return {
        productVariantId,
        warehouseId,
        method: report.champion?.method ?? null,
        earlier: null,
        recent: null,
        maeRatio: null,
        status: "insufficient_data",
        championChanged: false,
        findings: [
          `Drift needs at least ${ForecastDriftService.MIN_PERIODS_PER_HALF * 2} periods so each half can say something; this SKU has ${series.length}.`,
        ],
      };
    }

    if (!report.champion) {
      return {
        productVariantId,
        warehouseId,
        method: null,
        earlier: null,
        recent: null,
        maeRatio: null,
        status: "insufficient_data",
        championChanged: false,
        findings: [report.insufficientReason ?? "No baseline could be established."],
      };
    }

    const method = report.champion.method;
    const forecaster = BASELINES[method];
    if (!forecaster) {
      return {
        productVariantId,
        warehouseId,
        method,
        earlier: null,
        recent: null,
        maeRatio: null,
        status: "insufficient_data",
        championChanged: false,
        findings: [`No baseline implementation named ${method}.`],
      };
    }

    const half = Math.floor(series.length / 2);
    // Both halves are backtested with the same method and the same warm-up, so
    // the only thing that differs between them is the demand.
    const minTrain = Math.min(8, Math.floor(half / 2));
    const earlier = backtest(series.slice(0, half), forecaster, { minTrain });
    const recent = backtest(series.slice(half), forecaster, { minTrain });

    // Which method would win on recent data alone. A change here is often the
    // earliest signal, and it is worth reporting even when the error ratio has
    // not moved enough to call.
    const recentReport = await this.baselines.baseline(orgId, productVariantId, {
      weeks: Math.max(12, Math.floor(weeks / 2)),
      warehouseId,
    });
    const championChanged =
      recentReport.champion !== null && recentReport.champion.method !== method;

    let status: DriftReport["status"] = "stable";
    let maeRatio: number | null = null;

    if (earlier.n === 0 || recent.n === 0) {
      status = "insufficient_data";
      findings.push(
        "One half produced no comparable forecasts, so there is nothing to compare.",
      );
    } else if (earlier.mae === 0) {
      // A perfect earlier half means a flat series; the ratio would be infinite
      // and would read as catastrophic drift on a SKU that simply never moved.
      findings.push(
        "The earlier window had no forecast error at all, so a ratio against it would be meaningless.",
      );
    } else {
      maeRatio = Number((recent.mae / earlier.mae).toFixed(4));
      if (maeRatio >= ForecastDriftService.DEGRADATION_RATIO) {
        status = "degrading";
        findings.push(
          `${method} is ${maeRatio}× less accurate on recent demand than on earlier demand (MAE ${earlier.mae} → ${recent.mae}).`,
        );
      } else if (maeRatio <= ForecastDriftService.IMPROVEMENT_RATIO) {
        status = "improving";
        findings.push(
          `${method} has become more accurate on recent demand (MAE ${earlier.mae} → ${recent.mae}).`,
        );
      } else {
        findings.push(
          `${method} is performing comparably across both halves (MAE ${earlier.mae} → ${recent.mae}).`,
        );
      }
    }

    if (championChanged) {
      findings.push(
        `A different baseline (${recentReport.champion!.method}) now fits recent demand better than ${method}. That is often the earliest sign the demand shape has moved.`,
      );
    }

    // Bias is checked separately from error because it fails differently: a
    // forecast drifting steadily high has stable MAE and will fill a warehouse.
    if (recent.n > 0 && Math.abs(recent.bias) > recent.mae * 0.5 && recent.mae > 0) {
      findings.push(
        `Recent forecasts are consistently ${recent.bias > 0 ? "high" : "low"} (bias ${recent.bias} against MAE ${recent.mae}), which accumulates in one direction rather than cancelling out.`,
      );
    }

    return {
      productVariantId,
      warehouseId,
      method,
      earlier,
      recent,
      maeRatio,
      status,
      championChanged,
      previousChampion: championChanged ? method : undefined,
      findings,
    };
  }
}
