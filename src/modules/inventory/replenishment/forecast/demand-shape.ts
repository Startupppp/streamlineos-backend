/**
 * INV-302 — deciding what kind of demand this is before forecasting it.
 *
 * Ranking baselines by error (INV-301) answers "which fits best"; it does not
 * answer "is any of them appropriate". Those come apart badly on intermittent
 * demand, where a method can win the ranking while being structurally wrong:
 * forecast a flat 0.2 units a week for something that sells 10 units five times
 * a year and the error is small every single week, and the reorder point it
 * implies is nonsense.
 *
 * So demand is classified first, on the two properties that actually change
 * which method is defensible.
 */

/** Syntetos-Boylan cut-offs. Widely used, and worth naming rather than burying. */
const ADI_THRESHOLD = 1.32;
const CV2_THRESHOLD = 0.49;

export type DemandCategory =
  | "smooth"
  | "erratic"
  | "intermittent"
  | "lumpy"
  | "no_demand";

export interface DemandClassification {
  category: DemandCategory;
  /** Average interval between non-zero periods. 1 means demand every period. */
  adi: number;
  /** Squared coefficient of variation of the non-zero demand sizes. */
  cv2: number;
  nonZeroPeriods: number;
  /** What the classification implies about method choice. */
  guidance: string;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function classifyDemand(series: readonly number[]): DemandClassification {
  const nonZero = series.filter((v) => v > 0);
  if (nonZero.length === 0) {
    return {
      category: "no_demand",
      adi: 0,
      cv2: 0,
      nonZeroPeriods: 0,
      guidance:
        "Nothing has sold in this window. Any forecast would be an assertion rather than an estimate.",
    };
  }

  const adi = series.length / nonZero.length;
  const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
  // Variance of the sizes, not of the whole series: the interval is already
  // captured by ADI, and mixing the two makes every intermittent series look
  // erratic.
  const variance =
    nonZero.reduce((acc, v) => acc + (v - mean) ** 2, 0) / nonZero.length;
  const cv2 = mean === 0 ? 0 : variance / mean ** 2;

  const intermittent = adi >= ADI_THRESHOLD;
  const variable = cv2 >= CV2_THRESHOLD;

  const category: DemandCategory = intermittent
    ? variable
      ? "lumpy"
      : "intermittent"
    : variable
      ? "erratic"
      : "smooth";

  const guidance = {
    smooth:
      "Regular demand of consistent size. Ordinary smoothing or a moving average is appropriate.",
    erratic:
      "Demand every period but of unpredictable size. Forecast the level, and carry the variability in safety stock rather than in the forecast.",
    intermittent:
      "Demand arrives in gaps of consistent size. Croston-style rate estimation is appropriate; a period average is not.",
    lumpy:
      "Rare demand of unpredictable size. This is the hardest case and the one where a confident forecast is most misleading — prefer a stated range and human review.",
    no_demand: "",
  }[category];

  return {
    category,
    adi: round(adi),
    cv2: round(cv2),
    nonZeroPeriods: nonZero.length,
    guidance,
  };
}

export interface SeasonalityResult {
  seasonLength: number | null;
  /** Autocorrelation at the detected lag, -1..1. */
  strength: number;
  /** Every candidate that was tried, so a rejection is inspectable. */
  candidates: Array<{ lag: number; correlation: number }>;
}

/**
 * Autocorrelation at a given lag. Positive and large means the series looks
 * like itself one season ago, which is exactly the claim `seasonalNaive`
 * makes.
 */
export function autocorrelation(series: readonly number[], lag: number): number {
  if (lag <= 0 || series.length <= lag + 1) return 0;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < series.length; i += 1) {
    const centered = series[i]! - mean;
    denominator += centered * centered;
    if (i >= lag) numerator += centered * (series[i - lag]! - mean);
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Which season length, if any, this series actually has.
 *
 * A threshold rather than "the best of the candidates", because the best of a
 * set of weak correlations is still weak — and `seasonalNaive` applied to a
 * series with no season is strictly worse than a moving average, since it
 * propagates one period's noise forward forever.
 *
 * Requires two full cycles before it will name a lag at all. One cycle cannot
 * distinguish a season from a trend.
 */
export function detectSeasonality(
  series: readonly number[],
  candidateLags: readonly number[] = [7, 4, 12, 52],
  threshold = 0.4,
): SeasonalityResult {
  const candidates = candidateLags
    .filter((lag) => series.length >= lag * 2)
    .map((lag) => ({ lag, correlation: round(autocorrelation(series, lag)) }));

  const best = candidates.reduce<{ lag: number; correlation: number } | null>(
    (acc, c) => (acc === null || c.correlation > acc.correlation ? c : acc),
    null,
  );

  return {
    seasonLength: best && best.correlation >= threshold ? best.lag : null,
    strength: best?.correlation ?? 0,
    candidates,
  };
}
