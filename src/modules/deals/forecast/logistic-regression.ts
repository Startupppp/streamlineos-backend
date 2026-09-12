/**
 * The forecast itself: a ridge-penalised logistic regression, fitted per tenant.
 *
 * A statistical model rather than a language model, for four reasons a customer
 * can check. It is auditable — the answer is `intercept + Σ wᵢzᵢ` and every term
 * is shown. It is identical between runs on the same inputs — Newton's method
 * from a fixed start, no sampling, no ordering dependence. It costs a few
 * hundred floating-point operations per deal per day rather than a token bill.
 * And it carries an interval, because a fit on sixty examples is uncertain and
 * saying so is the difference between a forecast and a guess.
 *
 * The ridge term is not optional. Sales histories separate — every deal in the
 * closed-won stage was won — and unpenalised logistic regression on separable
 * data has no finite maximum: the coefficients run to infinity and every
 * probability becomes 0 or 1. The penalty bounds them, keeps the Hessian
 * invertible so an interval exists at all, and is the standard remedy for the
 * few-examples-per-variable regime every tenant starts in.
 */
import {
  DEAL_FEATURE_NAMES,
  FORECAST_FEATURE_SPEC_VERSION,
  type DealFeatureName,
  type DealOutcome,
} from "./deal-forecast-features";
import { quadraticForm, symmetricInverse, type Matrix } from "./matrix-solve";

export type FeatureValues = Readonly<Record<DealFeatureName, number>>;

export interface TrainingExample {
  readonly dealId: number;
  readonly closedAt: Date;
  readonly outcome: DealOutcome;
  readonly values: FeatureValues;
}

export interface FitOptions {
  /** Strength of the L2 penalty on the standardised coefficients. */
  readonly ridge?: number;
  readonly maxIterations?: number;
}

export interface FittedModel {
  readonly specVersion: string;
  readonly intercept: number;
  readonly weights: FeatureValues;
  readonly means: FeatureValues;
  readonly deviations: FeatureValues;
  /** Inverse penalised Fisher information, intercept first. (p+1) x (p+1). */
  readonly covariance: Matrix;
  readonly ridge: number;
  readonly iterations: number;
  readonly converged: boolean;
  readonly exampleCount: number;
  readonly wonCount: number;
}

export interface ScoreFactor {
  readonly feature: DealFeatureName;
  readonly value: number;
  readonly standardised: number;
  readonly contribution: number;
  readonly direction: "increases" | "decreases";
}

export interface ProbabilityInterval {
  readonly lower: number;
  readonly upper: number;
  readonly confidence: number;
}

export interface DealScore {
  readonly probability: number;
  readonly interval: ProbabilityInterval;
  readonly logit: number;
  readonly intercept: number;
  readonly factors: readonly ScoreFactor[];
}

export const DEFAULT_RIDGE = 1;
export const MAX_NEWTON_ITERATIONS = 50;
/** Two-sided normal quantile for 95%. */
export const INTERVAL_Z = 1.959964;
export const INTERVAL_CONFIDENCE = 0.95;
/** Per-iteration bound on any one coefficient's movement. */
const MAX_STEP = 4;
const CONVERGENCE = 1e-9;
const MIN_DEVIATION = 1e-12;
const MIN_WEIGHT = 1e-10;

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

function zeroed(): Record<DealFeatureName, number> {
  const out = {} as Record<DealFeatureName, number>;
  for (const name of DEAL_FEATURE_NAMES) out[name] = 0;
  return out;
}

/**
 * Column means and population deviations over the training set.
 *
 * Standardising is what makes the ridge penalty mean the same thing for a
 * feature counted in days and one counted in rupees, and what makes a
 * coefficient comparable to its neighbours when the factors are ranked. A
 * constant column gets a deviation of one, so its standardised values are all
 * zero and the penalty holds its weight at zero rather than dividing by nothing.
 */
function standardisation(examples: readonly TrainingExample[]): {
  means: Record<DealFeatureName, number>;
  deviations: Record<DealFeatureName, number>;
} {
  const means = zeroed();
  const deviations = zeroed();
  const n = examples.length;

  for (const name of DEAL_FEATURE_NAMES) {
    let total = 0;
    for (const example of examples) total += example.values[name];
    const mean = n === 0 ? 0 : total / n;

    let squared = 0;
    for (const example of examples) squared += (example.values[name] - mean) ** 2;
    const deviation = n === 0 ? 1 : Math.sqrt(squared / n);

    means[name] = mean;
    deviations[name] = deviation < MIN_DEVIATION ? 1 : deviation;
  }

  return { means, deviations };
}

function designRow(
  values: FeatureValues,
  means: FeatureValues,
  deviations: FeatureValues,
): number[] {
  const row = [1];
  for (const name of DEAL_FEATURE_NAMES)
    row.push((values[name] - means[name]) / deviations[name]);
  return row;
}

/**
 * Newton–Raphson on the penalised log-likelihood.
 *
 * Starts at zero, runs a fixed schedule and stops on a fixed tolerance, so two
 * runs over the same examples in the same order produce the same coefficients to
 * the last bit. The examples are sorted by close date and deal id before the fit
 * for the same reason — the caller's iteration order must not be able to change
 * the answer.
 */
export function fitLogisticModel(
  examples: readonly TrainingExample[],
  options: FitOptions = {},
): FittedModel {
  const ridge = options.ridge ?? DEFAULT_RIDGE;
  const maxIterations = options.maxIterations ?? MAX_NEWTON_ITERATIONS;

  const ordered = [...examples].sort(
    (a, b) => a.closedAt.getTime() - b.closedAt.getTime() || a.dealId - b.dealId,
  );
  const { means, deviations } = standardisation(ordered);

  const design = ordered.map((example) => designRow(example.values, means, deviations));
  const labels = ordered.map((example) => (example.outcome === "won" ? 1 : 0));
  const width = DEAL_FEATURE_NAMES.length + 1;

  let beta = new Array<number>(width).fill(0);
  let iterations = 0;
  let converged = false;

  for (let step = 0; step < maxIterations; step += 1) {
    iterations = step + 1;

    const { gradient, hessian } = penalisedDerivatives(design, labels, beta, ridge, width);
    const inverse = symmetricInverse(hessian);
    if (inverse === null) break;

    let largest = 0;
    const next = beta.slice();
    for (let j = 0; j < width; j += 1) {
      let delta = 0;
      const invRow = inverse[j];
      for (let k = 0; k < width; k += 1) delta += (invRow?.[k] ?? 0) * (gradient[k] ?? 0);
      const bounded = Math.max(-MAX_STEP, Math.min(MAX_STEP, delta));
      next[j] = (beta[j] ?? 0) + bounded;
      largest = Math.max(largest, Math.abs(bounded));
    }

    beta = next;
    if (largest < CONVERGENCE) {
      converged = true;
      break;
    }
  }

  // Recomputed at the coefficients actually returned, not at the ones the last
  // step started from: the interval has to describe the model being served.
  const { hessian: information } = penalisedDerivatives(design, labels, beta, ridge, width);
  const covariance = symmetricInverse(information) ?? identityTimes(width, 1 / Math.max(ridge, 1));

  const weights = zeroed();
  DEAL_FEATURE_NAMES.forEach((name, index) => {
    weights[name] = beta[index + 1] ?? 0;
  });

  return {
    specVersion: FORECAST_FEATURE_SPEC_VERSION,
    intercept: beta[0] ?? 0,
    weights,
    means,
    deviations,
    covariance,
    ridge,
    iterations,
    converged,
    exampleCount: ordered.length,
    wonCount: labels.filter((label) => label === 1).length,
  };
}

function identityTimes(size: number, scale: number): number[][] {
  return Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i === j ? scale : 0)),
  );
}

/**
 * Gradient and Hessian of the penalised log-likelihood at one set of
 * coefficients. The intercept is deliberately left out of the penalty — shrinking
 * it would bias every probability towards a half the tenant's history disagrees
 * with — so its diagonal carries only a floor that keeps the matrix invertible.
 */
function penalisedDerivatives(
  design: readonly number[][],
  labels: readonly number[],
  beta: readonly number[],
  ridge: number,
  width: number,
): { gradient: number[]; hessian: number[][] } {
  const gradient = new Array<number>(width).fill(0);
  const hessian = identityTimes(width, ridge);
  const first = hessian[0];
  if (first !== undefined) first[0] = MIN_WEIGHT;

  for (let i = 0; i < design.length; i += 1) {
    const row = design[i] ?? [];
    let eta = 0;
    for (let j = 0; j < width; j += 1) eta += (row[j] ?? 0) * (beta[j] ?? 0);

    const p = sigmoid(eta);
    const residual = (labels[i] ?? 0) - p;
    const weight = Math.max(p * (1 - p), MIN_WEIGHT);

    for (let j = 0; j < width; j += 1) {
      gradient[j] = (gradient[j] ?? 0) + (row[j] ?? 0) * residual;
      const hessianRow = hessian[j];
      if (hessianRow === undefined) continue;
      for (let k = 0; k < width; k += 1)
        hessianRow[k] = (hessianRow[k] ?? 0) + weight * (row[j] ?? 0) * (row[k] ?? 0);
    }
  }

  for (let j = 1; j < width; j += 1) gradient[j] = (gradient[j] ?? 0) - ridge * (beta[j] ?? 0);

  return { gradient, hessian };
}

/**
 * One deal's probability, its interval and the arithmetic behind both.
 *
 * The interval is a Wald bound on the log-odds pushed back through the logistic
 * curve, which keeps it inside [0, 1] by construction and asymmetric where the
 * probability is near an end — a 95% deal cannot be 105% at the top. It covers
 * the uncertainty in the fitted coefficients. It does not cover the possibility
 * that the tenant's process changed, which no interval can, and the cold-start
 * threshold exists because at small n the first kind of uncertainty is already
 * large enough to matter.
 */
export function scoreWithModel(model: FittedModel, values: FeatureValues): DealScore {
  const row = designRow(values, model.means, model.deviations);

  let logit = model.intercept;
  const factors: ScoreFactor[] = [];

  DEAL_FEATURE_NAMES.forEach((name, index) => {
    const standardised = row[index + 1] ?? 0;
    const contribution = model.weights[name] * standardised;
    logit += contribution;
    factors.push({
      feature: name,
      value: values[name],
      standardised,
      contribution,
      direction: contribution >= 0 ? "increases" : "decreases",
    });
  });

  const standardError = Math.sqrt(quadraticForm(model.covariance, row));
  const margin = INTERVAL_Z * standardError;

  factors.sort(
    (a, b) =>
      Math.abs(b.contribution) - Math.abs(a.contribution) ||
      a.feature.localeCompare(b.feature),
  );

  return {
    probability: sigmoid(logit),
    interval: {
      lower: sigmoid(logit - margin),
      upper: sigmoid(logit + margin),
      confidence: INTERVAL_CONFIDENCE,
    },
    logit,
    intercept: model.intercept,
    factors,
  };
}
