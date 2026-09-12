/**
 * INV-301 — forecast accuracy, and why not MAPE.
 *
 * MAPE is the metric everybody reaches for and the wrong one here. It divides
 * by the actual, and inventory demand is zero constantly -- every slow-moving
 * SKU, every quiet week. On a zero it is undefined, and near a zero it explodes,
 * so a MAPE over real demand history is dominated by the quietest periods
 * rather than the ones that cost money.
 *
 * So: MAE and RMSE in units, which are directly interpretable as "how many
 * units out were we", plus MASE, which scales the error against the naive
 * forecast and is therefore comparable across SKUs of wildly different volume.
 * MASE below 1 means "better than assuming tomorrow equals today"; above 1
 * means the model is worse than doing nothing, which is the single most useful
 * thing a forecast report can tell you.
 *
 * Bias is reported separately from error because they fail differently. A
 * forecast that is 10 units high half the time and 10 low the rest has good
 * bias and terrible accuracy; one that is always 5 high has decent accuracy and
 * will silently fill a warehouse.
 */
export interface AccuracyMetrics {
  n: number;
  mae: number;
  rmse: number;
  /** Mean error, signed. Positive means the forecast ran high. */
  bias: number;
  /** Null when the history is too short or too flat to scale against. */
  mase: number | null;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function accuracy(
  actuals: readonly number[],
  forecasts: readonly number[],
  /** In-sample history, used for the MASE scale. */
  scaleHistory: readonly number[] = [],
): AccuracyMetrics {
  const n = Math.min(actuals.length, forecasts.length);
  if (n === 0) return { n: 0, mae: 0, rmse: 0, bias: 0, mase: null };

  let absSum = 0;
  let sqSum = 0;
  let errSum = 0;
  for (let i = 0; i < n; i += 1) {
    const error = forecasts[i]! - actuals[i]!;
    absSum += Math.abs(error);
    sqSum += error * error;
    errSum += error;
  }

  const mae = absSum / n;

  // The naive one-step error over the in-sample history. If that is zero the
  // series never moved, and scaling against it would divide by nothing -- so
  // MASE is reported as unavailable rather than as infinity.
  let naiveSum = 0;
  for (let i = 1; i < scaleHistory.length; i += 1) {
    naiveSum += Math.abs(scaleHistory[i]! - scaleHistory[i - 1]!);
  }
  const naiveMae = scaleHistory.length > 1 ? naiveSum / (scaleHistory.length - 1) : 0;

  return {
    n,
    mae: round(mae),
    rmse: round(Math.sqrt(sqSum / n)),
    bias: round(errSum / n),
    mase: naiveMae > 0 ? round(mae / naiveMae) : null,
  };
}
