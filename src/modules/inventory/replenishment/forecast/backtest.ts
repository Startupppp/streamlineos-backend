import { BASELINES, type Forecaster } from "./baselines";
import { accuracy, type AccuracyMetrics } from "./accuracy";

export interface BacktestResult {
  method: string;
  metrics: AccuracyMetrics;
}

/**
 * INV-301 — rolling-origin backtest.
 *
 * The origin moves forward one period at a time and each forecast sees only the
 * history before it. That is the whole point: fitting on the full series and
 * then "predicting" periods the model has already seen produces beautiful
 * numbers and no information, and it is the single most common way a
 * forecasting claim turns out to be worthless in production.
 *
 * `minTrain` exists so the first forecasts are not made from two data points.
 * A method judged on a three-period warm-up is judged on noise.
 */
export function backtest(
  series: readonly number[],
  forecaster: Forecaster,
  options: { minTrain?: number; horizon?: number } = {},
): AccuracyMetrics {
  const { minTrain = 8, horizon = 1 } = options;
  const actuals: number[] = [];
  const forecasts: number[] = [];

  for (let origin = minTrain; origin + horizon <= series.length; origin += 1) {
    const train = series.slice(0, origin);
    const predicted = forecaster(train, horizon);
    for (let h = 0; h < horizon; h += 1) {
      forecasts.push(predicted[h] ?? 0);
      actuals.push(series[origin + h]!);
    }
  }

  return accuracy(actuals, forecasts, series.slice(0, minTrain));
}

/**
 * Every baseline over one series, ranked. Ranking by MAE rather than by MASE
 * because MASE is unavailable on a flat series and a ranking that silently
 * drops half its candidates is worse than one that uses a simpler measure.
 */
export function rankBaselines(
  series: readonly number[],
  options: { minTrain?: number; horizon?: number } = {},
): BacktestResult[] {
  return Object.entries(BASELINES)
    .map(([method, forecaster]) => ({
      method,
      metrics: backtest(series, forecaster, options),
    }))
    .sort((a, b) => a.metrics.mae - b.metrics.mae);
}
