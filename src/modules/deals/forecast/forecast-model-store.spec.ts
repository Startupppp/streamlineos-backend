import { DEAL_FEATURE_NAMES } from "./deal-forecast-features";
import { fitLogisticModel, scoreWithModel, type TrainingExample } from "./logistic-regression";
import {
  featureValuesFrom,
  featureValuesToRecord,
  fromStoredMetrics,
  rehydrateModel,
  toStoredMetrics,
} from "./forecast-model-store";
import type { StoredCoefficients } from "../../../db/schema/crm/deal-forecast";

/**
 * A model that survives a round trip through jsonb, and one that refuses to.
 *
 * The round trip is the whole reason the row carries coefficients rather than a
 * pointer: a score has to be reproducible months later, when the training deals
 * have moved on and nobody can re-derive it. If the rehydrated model scores a
 * vector differently from the one that was fitted, every stored probability is a
 * number nobody can defend.
 *
 * The refusals matter more. A missing key is not defaulted to zero, because zero
 * is a real standardised value meaning "average" — supplying it would turn a
 * corrupt row into a confident-looking forecast instead of a fallback to the
 * arithmetic the tenant already understood.
 */

const values = (seed: number) =>
  featureValuesFrom((name) => (DEAL_FEATURE_NAMES.indexOf(name) + 1) * seed);

function corpus(): TrainingExample[] {
  const examples: TrainingExample[] = [];
  for (let index = 0; index < 40; index += 1) {
    const won = index % 2 === 0;
    examples.push({
      dealId: index + 1,
      closedAt: new Date(2026, 0, index + 1),
      outcome: won ? "won" : "lost",
      values: featureValuesFrom((name) =>
        name === "activityCount" ? (won ? 12 : 2) : (DEAL_FEATURE_NAMES.indexOf(name) % 3) + index / 40,
      ),
    });
  }
  return examples;
}

describe("forecast model store", () => {
  const fitted = fitLogisticModel(corpus());

  const stored: StoredCoefficients = {
    intercept: fitted.intercept,
    weights: featureValuesToRecord(fitted.weights),
    means: featureValuesToRecord(fitted.means),
    deviations: featureValuesToRecord(fitted.deviations),
    covariance: fitted.covariance.map((row) => [...row]),
  };

  it("scores identically after a round trip through the row", () => {
    const rehydrated = rehydrateModel(
      fitted.specVersion,
      stored,
      fitted.ridge,
      fitted.iterations,
      fitted.converged,
      fitted.exampleCount,
      fitted.wonCount,
    );

    expect(rehydrated).not.toBeNull();
    const before = scoreWithModel(fitted, values(0.3));
    const after = scoreWithModel(rehydrated!, values(0.3));

    /** To the last bit: a reproducible score is the point of storing the model. */
    expect(after.probability).toBe(before.probability);
    expect(after.interval.lower).toBe(before.interval.lower);
    expect(after.interval.upper).toBe(before.interval.upper);
  });

  it("refuses a row that lost a feature rather than defaulting it to zero", () => {
    const { stageProbability: _dropped, ...rest } = stored.weights;
    expect(
      rehydrateModel(
        fitted.specVersion,
        { ...stored, weights: rest },
        fitted.ridge,
        fitted.iterations,
        fitted.converged,
        fitted.exampleCount,
        fitted.wonCount,
      ),
    ).toBeNull();
  });

  it("refuses a covariance of the wrong shape", () => {
    /**
     * The interval comes out of this matrix. A short one would not throw — it
     * would quietly produce a narrower interval than the evidence supports,
     * which is the failure mode that looks like a more confident model.
     */
    expect(
      rehydrateModel(
        fitted.specVersion,
        { ...stored, covariance: [[1, 2], [3, 4]] },
        fitted.ridge,
        fitted.iterations,
        fitted.converged,
        fitted.exampleCount,
        fitted.wonCount,
      ),
    ).toBeNull();
  });

  it("refuses a non-finite coefficient", () => {
    expect(
      rehydrateModel(
        fitted.specVersion,
        { ...stored, means: { ...stored.means, ageDays: Number.NaN } },
        fitted.ridge,
        fitted.iterations,
        fitted.converged,
        fitted.exampleCount,
        fitted.wonCount,
      ),
    ).toBeNull();
  });

  it("carries every metric through the column and back", () => {
    const metrics = {
      count: 12,
      brier: 0.18,
      logLoss: 0.54,
      auc: 0.71,
      calibrationError: 0.09,
      baseRate: 0.5,
    };
    expect(fromStoredMetrics(toStoredMetrics(metrics))).toEqual(metrics);
  });

  it("reads a missing metrics block as a coin rather than a certainty", () => {
    /**
     * `auc` defaults to 0.5 and not 0. Zero AUC would read as a model that ranks
     * perfectly backwards, which is a strong claim; 0.5 says nothing is known,
     * which is the truth about an unreadable row.
     */
    const empty = fromStoredMetrics({
      count: 0,
      brier: 0,
      logLoss: 0,
      auc: 0.5,
      calibrationError: 0,
      baseRate: 0,
    });
    expect(empty.auc).toBe(0.5);
  });
});
