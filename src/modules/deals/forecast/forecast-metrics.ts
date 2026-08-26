/**
 * How well the forecast actually did, measured the way a sceptic would.
 *
 * Three numbers, because each of them can be gamed alone. Brier says whether the
 * probabilities are close to the outcomes. AUC says whether the ranking is right
 * — a model that calls everything 30% has a respectable Brier and no ability to
 * tell two deals apart. Calibration says whether "70%" means seventy per cent,
 * which is the only reading under which a weighted pipeline total is a number
 * anyone can plan against.
 *
 * All three are compared against the naive weighted forecast the tenant already
 * had. A learned model that cannot beat the stage probabilities the tenant typed
 * in themselves has earned nothing and should not replace them.
 */

export interface Prediction {
  readonly probability: number;
  readonly won: boolean;
}

export interface ForecastMetrics {
  readonly count: number;
  readonly brier: number;
  readonly logLoss: number;
  readonly auc: number;
  readonly calibrationError: number;
  readonly baseRate: number;
}

const EPSILON = 1e-9;

function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - EPSILON, Math.max(EPSILON, p));
}

/** Mean squared error between the probability and the outcome. Lower is better. */
export function brierScore(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) return 0;
  let total = 0;
  for (const p of predictions) total += (clampProbability(p.probability) - (p.won ? 1 : 0)) ** 2;
  return total / predictions.length;
}

/** Mean negative log-likelihood. Punishes confident mistakes far harder than Brier. */
export function logLoss(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) return 0;
  let total = 0;
  for (const p of predictions) {
    const q = clampProbability(p.probability);
    total += p.won ? -Math.log(q) : -Math.log(1 - q);
  }
  return total / predictions.length;
}

/**
 * Probability that a won deal outscores a lost one, by the rank statistic.
 *
 * Mid-ranks for ties, so a model that gives every deal the same number scores
 * 0.5 — no ability to discriminate — rather than an accidental 1.0.
 */
export function rocAuc(predictions: readonly Prediction[]): number {
  const won = predictions.filter((p) => p.won).length;
  const lost = predictions.length - won;
  if (won === 0 || lost === 0) return 0.5;

  const ordered = [...predictions]
    .map((p, index) => ({ ...p, index, probability: clampProbability(p.probability) }))
    .sort((a, b) => a.probability - b.probability || a.index - b.index);

  const ranks = new Array<number>(ordered.length).fill(0);
  let i = 0;
  while (i < ordered.length) {
    let j = i;
    while (j + 1 < ordered.length && ordered[j + 1]?.probability === ordered[i]?.probability)
      j += 1;
    const midRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = midRank;
    i = j + 1;
  }

  let rankSum = 0;
  ordered.forEach((prediction, index) => {
    if (prediction.won) rankSum += ranks[index] ?? 0;
  });

  return (rankSum - (won * (won + 1)) / 2) / (won * lost);
}

export interface CalibrationBucket {
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly count: number;
  readonly predicted: number;
  readonly observed: number;
}

/** Ten equal-width buckets, each reporting what was promised against what happened. */
export function calibrationBuckets(
  predictions: readonly Prediction[],
  bucketCount = 10,
): CalibrationBucket[] {
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    lowerBound: i / bucketCount,
    upperBound: (i + 1) / bucketCount,
    count: 0,
    predictedTotal: 0,
    wonTotal: 0,
  }));

  for (const prediction of predictions) {
    const p = clampProbability(prediction.probability);
    const index = Math.min(bucketCount - 1, Math.floor(p * bucketCount));
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    bucket.count += 1;
    bucket.predictedTotal += p;
    bucket.wonTotal += prediction.won ? 1 : 0;
  }

  return buckets.map((bucket) => ({
    lowerBound: bucket.lowerBound,
    upperBound: bucket.upperBound,
    count: bucket.count,
    predicted: bucket.count === 0 ? 0 : bucket.predictedTotal / bucket.count,
    observed: bucket.count === 0 ? 0 : bucket.wonTotal / bucket.count,
  }));
}

/** Weighted mean gap between promise and outcome across the buckets. */
export function expectedCalibrationError(
  predictions: readonly Prediction[],
  bucketCount = 10,
): number {
  if (predictions.length === 0) return 0;
  let total = 0;
  for (const bucket of calibrationBuckets(predictions, bucketCount))
    total += (bucket.count / predictions.length) * Math.abs(bucket.predicted - bucket.observed);
  return total;
}

export function evaluate(predictions: readonly Prediction[]): ForecastMetrics {
  const won = predictions.filter((p) => p.won).length;
  return {
    count: predictions.length,
    brier: brierScore(predictions),
    logLoss: logLoss(predictions),
    auc: rocAuc(predictions),
    calibrationError: expectedCalibrationError(predictions),
    baseRate: predictions.length === 0 ? 0 : won / predictions.length,
  };
}

export interface Datable {
  readonly closedAt: Date;
  readonly dealId: number;
}

export interface Split<T> {
  readonly training: readonly T[];
  readonly holdout: readonly T[];
}

/**
 * Oldest deals to train on, newest to be judged against.
 *
 * A random split would let a model learn from March to be tested on February,
 * which is not the question anyone is asking: the forecast is used on deals that
 * have not closed yet, so it has to be measured on deals that closed after
 * everything it was shown. The tie-break on deal id keeps the split identical
 * between runs when several deals closed on the same day.
 */
export function chronologicalSplit<T extends Datable>(
  examples: readonly T[],
  holdoutFraction: number,
): Split<T> {
  const ordered = [...examples].sort(
    (a, b) => a.closedAt.getTime() - b.closedAt.getTime() || a.dealId - b.dealId,
  );

  const fraction = Math.min(0.9, Math.max(0, holdoutFraction));
  const holdoutSize = Math.floor(ordered.length * fraction);
  if (holdoutSize === 0) return { training: ordered, holdout: [] };

  return {
    training: ordered.slice(0, ordered.length - holdoutSize),
    holdout: ordered.slice(ordered.length - holdoutSize),
  };
}
