import {
  brierScore,
  chronologicalSplit,
  evaluate,
  type Prediction,
} from "../src/modules/deals/forecast/forecast-metrics";
import {
  FORECAST_ACCEPTANCE,
  HOLDOUT_FRACTION,
  acceptModel,
  assessForecastHistory,
} from "../src/modules/deals/forecast/forecast-cold-start";
import { FORECAST_BASELINE_DATASET } from "./datasets/forecast-baseline.dataset";

/**
 * CRM-P2-11, the forecast quarter: the bar a learned forecast has to clear,
 * measured before there is a learned forecast.
 *
 * `acceptModel` already refuses a model that is no better than the naive
 * weighted pipeline on Brier score. Nothing measured that, because there was no
 * corpus for the naive side — so the rule existed and could not have failed.
 * This suite makes the comparator a number, and pins the two properties that
 * make a comparison honest: the split is chronological, and the baseline is
 * imperfect.
 *
 * It deliberately does NOT assert an accuracy figure for a model. There is no
 * model. Asserting one would be the exact dishonesty the cold-start work was
 * written to avoid: a confident number nothing produced.
 */

const predictions = (cases: readonly (typeof FORECAST_BASELINE_DATASET)[number][]): Prediction[] =>
  cases.map((deal) => ({ probability: deal.stageProbability, won: deal.won }));

describe("the naive forecast baseline a learned model must beat", () => {
  const split = chronologicalSplit(FORECAST_BASELINE_DATASET, HOLDOUT_FRACTION);

  it("splits on time, never at random", () => {
    /**
     * The whole point of a holdout for a forecast: a random split lets a model
     * learn from deals that closed after the ones it is scored on, which is
     * information it will never have in production. Every training deal has to
     * close before every held-out one.
     */
    const lastTraining = split.training.at(-1);
    const firstHoldout = split.holdout[0];

    expect(split.training.length).toBeGreaterThan(0);
    expect(split.holdout.length).toBeGreaterThanOrEqual(FORECAST_ACCEPTANCE.minHoldoutDeals / 2);
    expect(lastTraining!.closedAt.getTime()).toBeLessThan(firstHoldout!.closedAt.getTime());
  });

  it("records what the weighted pipeline scores on the held-out deals", () => {
    const naive = evaluate(predictions(split.holdout));

    /**
     * The comparator, written down. A model that predicts worse than this is
     * refused by `acceptModel`, and until this file existed that clause had
     * nothing to compare against.
     */
    expect(naive.count).toBe(split.holdout.length);
    expect(naive.count).toBeGreaterThanOrEqual(FORECAST_ACCEPTANCE.minHoldoutDeals);
    expect(naive.brier).toBeGreaterThan(0);
    /**
     * Better than a coin on the held-out deals, which is the least a comparator
     * can be and still be one. It was not, in the first draft of this corpus:
     * stage-ordered rows put every confident deal in the holdout and the naive
     * forecast scored 0.253 against a coin's 0.25.
     */
    const coin = evaluate(split.holdout.map((deal) => ({ probability: 0.5, won: deal.won })));
    expect(naive.brier).toBeLessThan(coin.brier);
  });

  it("is imperfect, so the bar is neither unreachable nor free", () => {
    /**
     * A corpus where stage probability predicted the outcome exactly would set a
     * bar no model could clear; one where it were random would set a bar any
     * model clears. Both make `maxBrierRatioVsNaive` meaningless.
     */
    const perfect = brierScore(
      FORECAST_BASELINE_DATASET.map((deal) => ({
        probability: deal.won ? 1 : 0,
        won: deal.won,
      })),
    );
    const coin = brierScore(
      FORECAST_BASELINE_DATASET.map((deal) => ({ probability: 0.5, won: deal.won })),
    );
    const naive = brierScore(predictions(FORECAST_BASELINE_DATASET));

    /** Clamped away from the endpoints, so a perfect prediction is ~0 and not exactly 0. */
    expect(perfect).toBeLessThan(1e-6);
    expect(naive).toBeGreaterThan(perfect);
    expect(naive).toBeLessThan(coin);
  });

  it("refuses a model that ranks well and predicts badly", () => {
    /**
     * The clause this corpus exists to make live. A model can order deals
     * perfectly and still be badly calibrated — every probability pushed toward
     * the extremes — and a badly calibrated model makes a worse pipeline TOTAL,
     * which is the number people plan headcount against.
     */
    const naive = evaluate(predictions(split.holdout));
    /**
     * A monotone sharpening, so the ORDER is identical to the naive forecast's
     * and only the confidence changes. A two-bucket version would have looked
     * overconfident and scored a worse AUC through ties — which would have made
     * this test about the tie-breaking rather than about calibration.
     */
    const sharpen = (p: number) => p ** 3 / (p ** 3 + (1 - p) ** 3);
    const overconfident = evaluate(
      split.holdout.map((deal) => ({
        probability: sharpen(deal.stageProbability),
        won: deal.won,
      })),
    );

    expect(overconfident.auc).toBeCloseTo(naive.auc, 5);
    expect(acceptModel(overconfident, naive, true)).toEqual({
      accepted: false,
      reason: "no-better-than-naive",
    });
  });

  it("refuses a coin flip, however calibrated it looks", () => {
    const naive = evaluate(predictions(split.holdout));
    const coin = evaluate(split.holdout.map((deal) => ({ probability: 0.5, won: deal.won })));

    expect(acceptModel(coin, naive, true)).toEqual({
      accepted: false,
      reason: "cannot-discriminate",
    });
  });

  it("says how much history this corpus would still need to train on", () => {
    /**
     * Twenty-four closed deals is a comparator, not a training set, and saying
     * so here is what stops the next person reading this file as a dataset the
     * trainer could use.
     */
    const readiness = assessForecastHistory({
      won: FORECAST_BASELINE_DATASET.filter((deal) => deal.won).length,
      lost: FORECAST_BASELINE_DATASET.filter((deal) => !deal.won).length,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.closedDealsNeeded).toBeGreaterThan(0);
  });
});
