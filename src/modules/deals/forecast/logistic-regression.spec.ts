import {
  DEAL_FEATURE_NAMES,
  FORECAST_FEATURE_SPEC_VERSION,
  type DealFeatureName,
} from "./deal-forecast-features";
import {
  INTERVAL_Z,
  fitLogisticModel,
  scoreWithModel,
  type FeatureValues,
  type FittedModel,
  type TrainingExample,
} from "./logistic-regression";

function features(overrides: Partial<Record<DealFeatureName, number>> = {}): FeatureValues {
  const values = {} as Record<DealFeatureName, number>;
  for (const name of DEAL_FEATURE_NAMES) values[name] = 0;
  return { ...values, ...overrides };
}

function example(
  dealId: number,
  outcome: "won" | "lost",
  overrides: Partial<Record<DealFeatureName, number>> = {},
): TrainingExample {
  return {
    dealId,
    closedAt: new Date(Date.UTC(2026, 0, 1) + dealId * 86_400_000),
    outcome,
    values: features(overrides),
  };
}

/**
 * A model built by hand rather than fitted, so the score arithmetic can be
 * checked without also trusting the fit.
 */
function handModel(overrides: Partial<FittedModel> = {}): FittedModel {
  const width = DEAL_FEATURE_NAMES.length + 1;
  return {
    specVersion: FORECAST_FEATURE_SPEC_VERSION,
    intercept: 0,
    weights: features(),
    means: features(),
    deviations: features(
      Object.fromEntries(DEAL_FEATURE_NAMES.map((name) => [name, 1])) as Record<
        DealFeatureName,
        number
      >,
    ),
    covariance: Array.from({ length: width }, () => new Array<number>(width).fill(0)),
    ridge: 1,
    iterations: 1,
    converged: true,
    exampleCount: 100,
    wonCount: 50,
    ...overrides,
  };
}

/** A pipeline where high stage probability really does mean a win. */
function separableHistory(count: number): TrainingExample[] {
  return Array.from({ length: count }, (_, i) => {
    const won = i % 2 === 0;
    return example(i + 1, won ? "won" : "lost", {
      stageProbability: won ? 0.7 + (i % 5) / 100 : 0.2 + (i % 5) / 100,
      ageDays: 40 + (i % 11),
      activityCount: won ? 12 + (i % 4) : 3 + (i % 4),
      logValue: 4 + (i % 3) / 10,
    });
  });
}

describe("scoreWithModel", () => {
  /**
   * Worked by hand. One live feature with weight 2 and a standardised value of
   * 3 gives a log-odds of 6, so the probability is 1 / (1 + e⁻⁶) = 0.997527.
   * The variance is 0.25 from the intercept plus 3² x 0.04 = 0.36, so the
   * standard error is sqrt(0.61) = 0.781025 and the band on the log-odds is
   * 6 ± 1.959964 x 0.781025.
   */
  it("returns a probability, an interval and the arithmetic that produced them", () => {
    const width = DEAL_FEATURE_NAMES.length + 1;
    const covariance = Array.from({ length: width }, () => new Array<number>(width).fill(0));
    covariance[0][0] = 0.25;
    covariance[1][1] = 0.04;

    const model = handModel({
      weights: features({ stageProbability: 2 }),
      covariance,
    });

    const score = scoreWithModel(model, features({ stageProbability: 3 }));
    const se = Math.sqrt(0.61);

    expect(score.logit).toBeCloseTo(6, 12);
    expect(score.probability).toBeCloseTo(1 / (1 + Math.exp(-6)), 12);
    expect(score.interval.lower).toBeCloseTo(1 / (1 + Math.exp(-(6 - INTERVAL_Z * se))), 12);
    expect(score.interval.upper).toBeCloseTo(1 / (1 + Math.exp(-(6 + INTERVAL_Z * se))), 12);
    expect(score.interval.confidence).toBe(0.95);
  });

  it("keeps the interval inside [0, 1] however wide the band on the log-odds", () => {
    const width = DEAL_FEATURE_NAMES.length + 1;
    const covariance = Array.from({ length: width }, (_, i) =>
      Array.from({ length: width }, (_, j) => (i === j ? 400 : 0)),
    );

    const score = scoreWithModel(handModel({ covariance }), features());

    expect(score.interval.lower).toBeGreaterThanOrEqual(0);
    expect(score.interval.upper).toBeLessThanOrEqual(1);
    expect(score.interval.lower).toBeLessThanOrEqual(score.probability);
    expect(score.interval.upper).toBeGreaterThanOrEqual(score.probability);
  });

  /**
   * The property that makes the forecast arguable: the factors and the intercept
   * are the whole answer, so a rep can add them up.
   */
  it("shows factors that reconstruct the log-odds exactly", () => {
    const model = handModel({
      intercept: -0.4,
      weights: features({ stageProbability: 1.5, ageDays: -0.8, activityCount: 0.3 }),
      means: features({ ageDays: 30 }),
    });

    const score = scoreWithModel(
      model,
      features({ stageProbability: 0.6, ageDays: 90, activityCount: 12 }),
    );
    const summed = score.factors.reduce((total, factor) => total + factor.contribution, 0);

    expect(summed + score.intercept).toBeCloseTo(score.logit, 12);
    expect(Math.log(score.probability / (1 - score.probability))).toBeCloseTo(score.logit, 10);
  });

  it("ranks the factors by how far each moved the answer", () => {
    const model = handModel({
      weights: features({ stageProbability: 1.5, ageDays: -0.8, activityCount: 0.3 }),
    });

    const score = scoreWithModel(
      model,
      features({ stageProbability: 1, ageDays: 1, activityCount: 1 }),
    );
    const magnitudes = score.factors.map((factor) => Math.abs(factor.contribution));

    expect(score.factors[0]?.feature).toBe("stageProbability");
    expect(score.factors[1]?.feature).toBe("ageDays");
    expect(score.factors[0]?.direction).toBe("increases");
    expect(score.factors[1]?.direction).toBe("decreases");
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
    expect(score.factors).toHaveLength(DEAL_FEATURE_NAMES.length);
  });
});

describe("fitLogisticModel", () => {
  it("is identical between runs on the same inputs", () => {
    const history = separableHistory(80);
    const first = fitLogisticModel(history);
    const second = fitLogisticModel(history);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("does not depend on the order the examples arrive in", () => {
    const history = separableHistory(80);
    const shuffled = [...history].reverse();

    expect(JSON.stringify(fitLogisticModel(history))).toBe(
      JSON.stringify(fitLogisticModel(shuffled)),
    );
  });

  it("learns the direction of a signal that is really there", () => {
    const model = fitLogisticModel(separableHistory(120));

    expect(model.converged).toBe(true);
    expect(model.weights.stageProbability).toBeGreaterThan(0);
    expect(model.weights.activityCount).toBeGreaterThan(0);
  });

  it("separates the deals it was shown", () => {
    const model = fitLogisticModel(separableHistory(120));

    const strong = scoreWithModel(model, features({ stageProbability: 0.75, activityCount: 14 }));
    const weak = scoreWithModel(model, features({ stageProbability: 0.2, activityCount: 3 }));

    expect(strong.probability).toBeGreaterThan(weak.probability);
  });

  /**
   * Unpenalised, this is the case with no finite answer: every won deal has a
   * feature no lost deal has, so the coefficient runs to infinity and every
   * probability collapses to 0 or 1. The ridge term is what keeps it finite.
   */
  it("stays finite on a perfectly separable history", () => {
    const perfect = Array.from({ length: 60 }, (_, i) =>
      example(i + 1, i % 2 === 0 ? "won" : "lost", {
        stageProbability: i % 2 === 0 ? 1 : 0,
      }),
    );

    const model = fitLogisticModel(perfect);
    const score = scoreWithModel(model, features({ stageProbability: 1 }));

    expect(Number.isFinite(model.weights.stageProbability)).toBe(true);
    expect(Number.isFinite(score.probability)).toBe(true);
    expect(score.probability).toBeLessThan(1);
    expect(score.interval.upper).toBeGreaterThan(score.probability);
  });

  it("gives a constant feature no weight rather than dividing by nothing", () => {
    const model = fitLogisticModel(separableHistory(60));

    expect(model.deviations.regressionCount).toBe(1);
    expect(model.weights.regressionCount).toBeCloseTo(0, 9);
    expect(Number.isNaN(model.weights.regressionCount)).toBe(false);
  });

  it("returns the tenant's own base rate when nothing distinguishes a win", () => {
    const noise = Array.from({ length: 100 }, (_, i) =>
      example(i + 1, i < 30 ? "won" : "lost", { stageProbability: 0.4 }),
    );

    const model = fitLogisticModel(noise);
    const score = scoreWithModel(model, features({ stageProbability: 0.4 }));

    expect(score.probability).toBeCloseTo(0.3, 2);
  });

  it("survives an empty history without producing a number", () => {
    const model = fitLogisticModel([]);
    const score = scoreWithModel(model, features({ stageProbability: 0.5 }));

    expect(model.exampleCount).toBe(0);
    expect(Number.isFinite(score.probability)).toBe(true);
    expect(score.probability).toBeCloseTo(0.5, 6);
  });

  /**
   * Less evidence has to mean a wider band, or the interval is decoration.
   */
  it("reports a wider interval when it has been shown fewer deals", () => {
    const few = fitLogisticModel(separableHistory(30));
    const many = fitLogisticModel(separableHistory(400));
    const probe = features({ stageProbability: 0.7, activityCount: 12, ageDays: 45, logValue: 4 });

    const narrow = scoreWithModel(many, probe).interval;
    const wide = scoreWithModel(few, probe).interval;

    expect(wide.upper - wide.lower).toBeGreaterThan(narrow.upper - narrow.lower);
  });

  it("carries the feature spec version it was fitted under", () => {
    expect(fitLogisticModel(separableHistory(60)).specVersion).toBe(
      FORECAST_FEATURE_SPEC_VERSION,
    );
  });
});
