/**
 * INV-301 — deterministic demand baselines.
 *
 * The phase rule is that these are the source of arithmetic and a model may
 * only replace one after a measured backtest beats it. That only means anything
 * if the baselines are honest, so they are implemented exactly as named rather
 * than as a moving average wearing three different labels.
 *
 * All of them are pure and take a series oldest-first, because a forecast that
 * silently depends on the caller's sort order is a forecast that will one day
 * be computed backwards and look plausible.
 */

export type Forecaster = (history: readonly number[], horizon: number) => number[];

function repeat(value: number, horizon: number): number[] {
  return Array.from({ length: horizon }, () => value);
}

/**
 * Tomorrow looks like today. Weak, and the one everything else has to beat:
 * a forecasting system that cannot outperform "the same as last period" has
 * bought nothing with its complexity.
 */
export const naive: Forecaster = (history, horizon) =>
  repeat(history.length === 0 ? 0 : history[history.length - 1]!, horizon);

/** The mean of the last `window` periods, or of everything if history is shorter. */
export function movingAverage(window: number): Forecaster {
  return (history, horizon) => {
    if (history.length === 0) return repeat(0, horizon);
    const slice = history.slice(Math.max(0, history.length - window));
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    return repeat(mean, horizon);
  };
}

/**
 * The same period one season ago — the right baseline for anything with a
 * weekly or annual rhythm, and the one a plain average quietly destroys.
 * Falls back to naive when there is not yet a full season of history, rather
 * than inventing a seasonal claim from data that cannot support one.
 */
export function seasonalNaive(seasonLength: number): Forecaster {
  return (history, horizon) => {
    if (history.length < seasonLength) return naive(history, horizon);
    return Array.from({ length: horizon }, (_, i) => {
      const index = history.length - seasonLength + (i % seasonLength);
      return history[index] ?? 0;
    });
  };
}

/**
 * Simple exponential smoothing. `alpha` is how much the most recent period
 * counts: 1 is naive, near 0 is a long average.
 */
export function exponentialSmoothing(alpha: number): Forecaster {
  return (history, horizon) => {
    if (history.length === 0) return repeat(0, horizon);
    let level = history[0]!;
    for (let i = 1; i < history.length; i += 1) {
      level = alpha * history[i]! + (1 - alpha) * level;
    }
    return repeat(level, horizon);
  };
}

/**
 * Croston's method, for demand that is mostly zero.
 *
 * This is the case ordinary smoothing gets badly wrong: average a series that
 * is zero four weeks in five and you forecast a fifth of a unit every week,
 * which is both never right and never obviously wrong. Croston forecasts the
 * *size* of a demand and the *interval* between demands separately, then
 * divides — so it answers "about 5 units roughly every 5 weeks" rather than
 * "1 unit per week, always".
 */
export function croston(alpha = 0.1): Forecaster {
  return (history, horizon) => {
    const nonZeroIndices = history
      .map((value, index) => ({ value, index }))
      .filter((p) => p.value > 0);
    if (nonZeroIndices.length === 0) return repeat(0, horizon);

    let size = nonZeroIndices[0]!.value;
    let interval = nonZeroIndices[0]!.index + 1;
    let previousIndex = nonZeroIndices[0]!.index;

    for (let i = 1; i < nonZeroIndices.length; i += 1) {
      const point = nonZeroIndices[i]!;
      size = alpha * point.value + (1 - alpha) * size;
      interval = alpha * (point.index - previousIndex) + (1 - alpha) * interval;
      previousIndex = point.index;
    }

    return repeat(interval === 0 ? size : size / interval, horizon);
  };
}

export const BASELINES: Record<string, Forecaster> = {
  naive,
  moving_average_4: movingAverage(4),
  moving_average_12: movingAverage(12),
  seasonal_naive_7: seasonalNaive(7),
  exponential_smoothing: exponentialSmoothing(0.3),
  croston: croston(0.1),
};
