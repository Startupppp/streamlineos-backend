/**
 * CRM-P2-11, the forecast quarter. A held-out set of closed deals, and the
 * number the naive forecast puts on each of them.
 *
 * There is no learned forecast to measure. `crm_deal_forecast_models` has no
 * writer and `assessForecastHistory` gates one behind 60 closed deals with 15
 * of each outcome, so what a caller gets today is the weighted pipeline: the
 * stage's probability, multiplied by the value. That is the comparator
 * `acceptModel` already requires a trained model to beat on Brier score, and
 * this file is what makes that requirement checkable before the trainer exists.
 *
 * So this dataset is the baseline, not a target. Its job is to fail the day
 * somebody ships a model that ranks well and predicts worse — which
 * `maxBrierRatioVsNaive` was written to prevent and which nothing currently
 * measures, because there is no corpus for it to measure against.
 *
 * The deals are synthetic and the shape is the point: stage probability
 * correlates with outcome, imperfectly, exactly as it does in a real book. A
 * corpus where the naive forecast were perfect would set a bar no model could
 * clear; one where it were random would set a bar any model clears.
 */

/**
 * Shaped to `Datable` so `chronologicalSplit` takes it directly — a numeric
 * `dealId` and a real `Date`, rather than a fixture the suite has to map into
 * the production type. A dataset that needs adapting is a dataset measuring the
 * adapter.
 */
export interface ForecastBaselineCase {
  readonly dealId: number;
  /** The stage's own probability, 0..1 — what the weighted pipeline uses. */
  readonly stageProbability: number;
  readonly valueMinor: number;
  readonly closedAt: Date;
  /** What actually happened. */
  readonly won: boolean;
}

/**
 * Forty-eight closed deals, one a week through 2026, six stages interleaved.
 *
 * Two properties are load-bearing and neither is decoration.
 *
 * **The stages are interleaved through time.** The first draft of this file
 * listed the deals in stage order, which made stage correlate with close date —
 * so the chronological holdout was nothing but late-stage deals and the naive
 * forecast scored WORSE on it than a coin flip. A real book does not close its
 * hopeless deals first, and a corpus that says it does measures the ordering
 * rather than the forecast.
 *
 * **The outcomes are imperfect and calibrated.** Each stage's win rate lands
 * near its stated probability (0%, 25%, 50%, 62%, 75%, 88% against 10%, 25%,
 * 40%, 60%, 80%, 90%) rather than on it. A corpus where the stage probability
 * predicted the outcome exactly would set a bar no model could clear; one where
 * it were random would set a bar any model clears. Both make
 * `maxBrierRatioVsNaive` meaningless.
 *
 * Forty-eight rather than twenty-four because `minHoldoutDeals` is 10 and a 25%
 * holdout of twenty-four is six — `acceptModel` refuses that as `no-holdout`
 * before it looks at anything, so every comparison below would have been
 * answering the wrong question.
 */
export const FORECAST_BASELINE_DATASET: readonly ForecastBaselineCase[] = [
  { dealId: 1, stageProbability: 0.1, valueMinor: 100_000, closedAt: new Date("2026-01-06"), won: false },
  { dealId: 2, stageProbability: 0.25, valueMinor: 280_000, closedAt: new Date("2026-01-13"), won: false },
  { dealId: 3, stageProbability: 0.4, valueMinor: 460_000, closedAt: new Date("2026-01-20"), won: false },
  { dealId: 4, stageProbability: 0.6, valueMinor: 640_000, closedAt: new Date("2026-01-27"), won: true },
  { dealId: 5, stageProbability: 0.8, valueMinor: 820_000, closedAt: new Date("2026-02-03"), won: true },
  { dealId: 6, stageProbability: 0.9, valueMinor: 190_000, closedAt: new Date("2026-02-10"), won: false },
  { dealId: 7, stageProbability: 0.1, valueMinor: 370_000, closedAt: new Date("2026-02-17"), won: false },
  { dealId: 8, stageProbability: 0.25, valueMinor: 550_000, closedAt: new Date("2026-02-24"), won: false },
  { dealId: 9, stageProbability: 0.4, valueMinor: 730_000, closedAt: new Date("2026-03-03"), won: true },
  { dealId: 10, stageProbability: 0.6, valueMinor: 100_000, closedAt: new Date("2026-03-10"), won: true },
  { dealId: 11, stageProbability: 0.8, valueMinor: 280_000, closedAt: new Date("2026-03-17"), won: false },
  { dealId: 12, stageProbability: 0.9, valueMinor: 460_000, closedAt: new Date("2026-03-24"), won: true },
  { dealId: 13, stageProbability: 0.1, valueMinor: 640_000, closedAt: new Date("2026-03-31"), won: false },
  { dealId: 14, stageProbability: 0.25, valueMinor: 820_000, closedAt: new Date("2026-04-07"), won: false },
  { dealId: 15, stageProbability: 0.4, valueMinor: 190_000, closedAt: new Date("2026-04-14"), won: true },
  { dealId: 16, stageProbability: 0.6, valueMinor: 370_000, closedAt: new Date("2026-04-21"), won: false },
  { dealId: 17, stageProbability: 0.8, valueMinor: 550_000, closedAt: new Date("2026-04-28"), won: true },
  { dealId: 18, stageProbability: 0.9, valueMinor: 730_000, closedAt: new Date("2026-05-05"), won: true },
  { dealId: 19, stageProbability: 0.1, valueMinor: 100_000, closedAt: new Date("2026-05-12"), won: false },
  { dealId: 20, stageProbability: 0.25, valueMinor: 280_000, closedAt: new Date("2026-05-19"), won: true },
  { dealId: 21, stageProbability: 0.4, valueMinor: 460_000, closedAt: new Date("2026-05-26"), won: false },
  { dealId: 22, stageProbability: 0.6, valueMinor: 640_000, closedAt: new Date("2026-06-02"), won: false },
  { dealId: 23, stageProbability: 0.8, valueMinor: 820_000, closedAt: new Date("2026-06-09"), won: true },
  { dealId: 24, stageProbability: 0.9, valueMinor: 190_000, closedAt: new Date("2026-06-16"), won: true },
  { dealId: 25, stageProbability: 0.1, valueMinor: 370_000, closedAt: new Date("2026-06-23"), won: false },
  { dealId: 26, stageProbability: 0.25, valueMinor: 550_000, closedAt: new Date("2026-06-30"), won: false },
  { dealId: 27, stageProbability: 0.4, valueMinor: 730_000, closedAt: new Date("2026-07-07"), won: false },
  { dealId: 28, stageProbability: 0.6, valueMinor: 100_000, closedAt: new Date("2026-07-14"), won: true },
  { dealId: 29, stageProbability: 0.8, valueMinor: 280_000, closedAt: new Date("2026-07-21"), won: true },
  { dealId: 30, stageProbability: 0.9, valueMinor: 460_000, closedAt: new Date("2026-07-28"), won: true },
  { dealId: 31, stageProbability: 0.1, valueMinor: 640_000, closedAt: new Date("2026-08-04"), won: false },
  { dealId: 32, stageProbability: 0.25, valueMinor: 820_000, closedAt: new Date("2026-08-11"), won: false },
  { dealId: 33, stageProbability: 0.4, valueMinor: 190_000, closedAt: new Date("2026-08-18"), won: false },
  { dealId: 34, stageProbability: 0.6, valueMinor: 370_000, closedAt: new Date("2026-08-25"), won: true },
  { dealId: 35, stageProbability: 0.8, valueMinor: 550_000, closedAt: new Date("2026-09-01"), won: true },
  { dealId: 36, stageProbability: 0.9, valueMinor: 730_000, closedAt: new Date("2026-09-08"), won: true },
  { dealId: 37, stageProbability: 0.1, valueMinor: 100_000, closedAt: new Date("2026-09-15"), won: false },
  { dealId: 38, stageProbability: 0.25, valueMinor: 280_000, closedAt: new Date("2026-09-22"), won: false },
  { dealId: 39, stageProbability: 0.4, valueMinor: 460_000, closedAt: new Date("2026-09-29"), won: true },
  { dealId: 40, stageProbability: 0.6, valueMinor: 640_000, closedAt: new Date("2026-10-06"), won: true },
  { dealId: 41, stageProbability: 0.8, valueMinor: 820_000, closedAt: new Date("2026-10-13"), won: false },
  { dealId: 42, stageProbability: 0.9, valueMinor: 190_000, closedAt: new Date("2026-10-20"), won: true },
  { dealId: 43, stageProbability: 0.1, valueMinor: 370_000, closedAt: new Date("2026-10-27"), won: false },
  { dealId: 44, stageProbability: 0.25, valueMinor: 550_000, closedAt: new Date("2026-11-03"), won: true },
  { dealId: 45, stageProbability: 0.4, valueMinor: 730_000, closedAt: new Date("2026-11-10"), won: true },
  { dealId: 46, stageProbability: 0.6, valueMinor: 100_000, closedAt: new Date("2026-11-17"), won: false },
  { dealId: 47, stageProbability: 0.8, valueMinor: 280_000, closedAt: new Date("2026-11-24"), won: true },
  { dealId: 48, stageProbability: 0.9, valueMinor: 460_000, closedAt: new Date("2026-12-01"), won: true },
];
