import {
  DEAL_FEATURE_NAMES,
  FORECAST_FEATURE_CAPS,
  FORECAST_FEATURE_SPEC_VERSION,
  assembleDealFeatures,
  emptyHistoricalRates,
  smoothedWinRate,
  summariseActivityWindow,
  toFeatureArray,
  type DealFeatureInput,
  type HistoricalRates,
} from "./deal-forecast-features";

const AS_OF = new Date("2026-08-24T00:00:00.000Z");
const DAY = 86_400_000;

function daysBefore(days: number): Date {
  return new Date(AS_OF.getTime() - days * DAY);
}

const STAGE_PROBABILITIES = new Map<string, number>([
  ["LEAD", 10],
  ["CONTACTED", 25],
  ["PROPOSAL", 50],
  ["NEGOTIATION", 75],
]);

function rates(overrides: Partial<HistoricalRates> = {}): HistoricalRates {
  return { ...emptyHistoricalRates(), ...overrides };
}

function baseInput(overrides: Partial<DealFeatureInput> = {}): DealFeatureInput {
  return {
    asOf: AS_OF,
    deal: {
      dealId: 42,
      createdAt: daysBefore(100),
      valueMinor: 1_000_000,
      stage: "PROPOSAL",
      expectedCloseDate: new Date("2026-09-23T00:00:00.000Z"),
      assignedToId: "rep-1",
      sourceKey: "referral",
    },
    timeline: {
      moves: [
        { fromStage: null, toStage: "LEAD", occurredAt: daysBefore(100) },
        { fromStage: "LEAD", toStage: "CONTACTED", occurredAt: daysBefore(80) },
        { fromStage: "CONTACTED", toStage: "PROPOSAL", occurredAt: daysBefore(20) },
      ],
      activityCount: 20,
      lastActivityAt: daysBefore(5),
    },
    stageProbabilities: STAGE_PROBABILITIES,
    rates: rates(),
    ownOutcome: null,
    ...overrides,
  };
}

describe("smoothedWinRate", () => {
  /**
   * Worked by hand: 3 wins of 5, a prior of 0.4 and a prior weight of 10 give
   * (3 + 0.4 x 10) / (5 + 10) = 7 / 15 = 0.4666...
   */
  it("pulls a small sample towards the prior", () => {
    expect(smoothedWinRate({ won: 3, total: 5 }, 0.4)).toBeCloseTo(7 / 15, 12);
  });

  it("is the prior exactly when there is no history at all", () => {
    expect(smoothedWinRate({ won: 0, total: 0 }, 0.37)).toBeCloseTo(0.37, 12);
  });

  /**
   * 400 wins of 500: (400 + 4) / (500 + 10) = 404 / 510 = 0.7921..., a hair
   * under the raw 0.8. A large sample is allowed to speak for itself.
   */
  it("barely moves a large sample", () => {
    expect(smoothedWinRate({ won: 400, total: 500 }, 0.4)).toBeCloseTo(404 / 510, 12);
  });

  it("never returns a rate outside [0, 1], however incoherent the counts", () => {
    for (const counts of [
      { won: -5, total: 1 },
      { won: 99, total: 1 },
      { won: 4, total: -20 },
    ]) {
      const rate = smoothedWinRate(counts, 0.5);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });
});

describe("summariseActivityWindow", () => {
  it("counts only what happened at or before the moment being scored", () => {
    const summary = summariseActivityWindow(
      [daysBefore(30), daysBefore(3), new Date(AS_OF.getTime() + DAY)],
      AS_OF,
    );

    expect(summary).toEqual({ activityCount: 2, lastActivityAt: daysBefore(3) });
  });

  it("caps the count so one noisy deal cannot dominate the model", () => {
    const many = Array.from({ length: FORECAST_FEATURE_CAPS.maxActivities + 40 }, (_, i) =>
      daysBefore(i + 1),
    );

    expect(summariseActivityWindow(many, AS_OF).activityCount).toBe(
      FORECAST_FEATURE_CAPS.maxActivities,
    );
  });

  it("reports no last activity when there is none in the window", () => {
    expect(summariseActivityWindow([], AS_OF)).toEqual({
      activityCount: 0,
      lastActivityAt: null,
    });
  });
});

describe("assembleDealFeatures", () => {
  it("emits exactly the declared feature set, in the declared order", () => {
    const vector = assembleDealFeatures(baseInput());

    expect(Object.keys(vector.values).sort()).toEqual([...DEAL_FEATURE_NAMES].sort());
    expect(toFeatureArray(vector.values)).toHaveLength(DEAL_FEATURE_NAMES.length);
    expect(vector.specVersion).toBe(FORECAST_FEATURE_SPEC_VERSION);
  });

  /**
   * The whole vector, by hand, for the fixture above.
   *
   * age 100d; last move 20d ago; two forward moves (10 -> 25 -> 50) and no
   * regression; 20 activities over 100/7 = 14.2857 weeks = 1.4 per week; last
   * activity 5d ago; expected close 30d out; stage probability 50/100; value
   * 1_000_000 minor = 10_000 major, log10(10_001) = 4.0000434...
   */
  it("computes every feature from the deal, its ledger and its timeline", () => {
    const vector = assembleDealFeatures(baseInput());

    expect(vector.values).toEqual({
      stageProbability: 0.5,
      logValue: Math.log10(10_001),
      ageDays: 100,
      currentStageDwellDays: 20,
      advanceCount: 2,
      regressionCount: 0,
      activityCount: 20,
      daysSinceLastActivity: 5,
      activitiesPerWeek: 20 / (100 / 7),
      daysToExpectedClose: 30,
      hasExpectedCloseDate: 1,
      expectedCloseOverdue: 0,
      repWinRate: 0.5,
      sourceWinRate: 0.5,
    });
  });

  it("is reproducible: the same deal at the same moment gives the identical vector", () => {
    expect(assembleDealFeatures(baseInput())).toEqual(assembleDealFeatures(baseInput()));
  });

  it("ignores every ledger entry after the moment being scored", () => {
    const withFuture = assembleDealFeatures(
      baseInput({
        timeline: {
          moves: [
            { fromStage: null, toStage: "LEAD", occurredAt: daysBefore(100) },
            { fromStage: "LEAD", toStage: "CONTACTED", occurredAt: daysBefore(80) },
            { fromStage: "CONTACTED", toStage: "PROPOSAL", occurredAt: daysBefore(20) },
            {
              fromStage: "PROPOSAL",
              toStage: "NEGOTIATION",
              occurredAt: new Date(AS_OF.getTime() + 5 * DAY),
            },
          ],
          activityCount: 20,
          lastActivityAt: daysBefore(5),
        },
      }),
    );

    expect(withFuture.values).toEqual(assembleDealFeatures(baseInput()).values);
  });

  it("counts a move back down the pipeline as a regression", () => {
    const vector = assembleDealFeatures(
      baseInput({
        deal: { ...baseInput().deal, stage: "CONTACTED" },
        timeline: {
          moves: [
            { fromStage: null, toStage: "LEAD", occurredAt: daysBefore(100) },
            { fromStage: "LEAD", toStage: "PROPOSAL", occurredAt: daysBefore(80) },
            { fromStage: "PROPOSAL", toStage: "CONTACTED", occurredAt: daysBefore(20) },
          ],
          activityCount: 20,
          lastActivityAt: daysBefore(5),
        },
      }),
    );

    expect(vector.values.advanceCount).toBe(1);
    expect(vector.values.regressionCount).toBe(1);
    expect(vector.values.stageProbability).toBe(0.25);
  });

  it("treats a deal with no ledger entries as dwelling since it was created", () => {
    const vector = assembleDealFeatures(
      baseInput({
        timeline: { moves: [], activityCount: 0, lastActivityAt: null },
      }),
    );

    expect(vector.values.currentStageDwellDays).toBe(100);
    expect(vector.values.advanceCount).toBe(0);
    expect(vector.values.daysSinceLastActivity).toBe(100);
    expect(vector.values.activitiesPerWeek).toBe(0);
  });

  it("says so rather than inventing a date when the close date is missing", () => {
    const vector = assembleDealFeatures(
      baseInput({ deal: { ...baseInput().deal, expectedCloseDate: null } }),
    );

    expect(vector.values.hasExpectedCloseDate).toBe(0);
    expect(vector.values.daysToExpectedClose).toBe(0);
    expect(vector.values.expectedCloseOverdue).toBe(0);
  });

  it("marks a close date that has already passed", () => {
    const vector = assembleDealFeatures(
      baseInput({ deal: { ...baseInput().deal, expectedCloseDate: daysBefore(9) } }),
    );

    expect(vector.values.daysToExpectedClose).toBe(-9);
    expect(vector.values.expectedCloseOverdue).toBe(1);
  });

  it("clamps every unbounded quantity to its cap", () => {
    const vector = assembleDealFeatures(
      baseInput({
        deal: {
          ...baseInput().deal,
          createdAt: daysBefore(5_000),
          valueMinor: Number.MAX_SAFE_INTEGER,
          expectedCloseDate: new Date(AS_OF.getTime() + 5_000 * DAY),
        },
        timeline: {
          moves: [{ fromStage: null, toStage: "LEAD", occurredAt: daysBefore(4_000) }],
          activityCount: 10_000,
          lastActivityAt: null,
        },
      }),
    );

    expect(vector.values.ageDays).toBe(FORECAST_FEATURE_CAPS.maxAgeDays);
    expect(vector.values.currentStageDwellDays).toBe(FORECAST_FEATURE_CAPS.maxDwellDays);
    expect(vector.values.activityCount).toBe(FORECAST_FEATURE_CAPS.maxActivities);
    expect(vector.values.daysToExpectedClose).toBe(FORECAST_FEATURE_CAPS.maxDaysToClose);
    expect(vector.values.daysSinceLastActivity).toBe(FORECAST_FEATURE_CAPS.maxAgeDays);
    expect(vector.values.logValue).toBe(
      Math.log10(1 + FORECAST_FEATURE_CAPS.maxValueMinor / 100),
    );
    expect(vector.values.activitiesPerWeek).toBeLessThanOrEqual(
      FORECAST_FEATURE_CAPS.maxActivitiesPerWeek,
    );
  });

  it("uses the tenant's own stage probability, not a hard-coded ladder", () => {
    const vector = assembleDealFeatures(
      baseInput({ stageProbabilities: new Map([["PROPOSAL", 80]]) }),
    );

    expect(vector.values.stageProbability).toBe(0.8);
  });

  it("falls back to the tenant's own base rate for a stage it does not know", () => {
    const vector = assembleDealFeatures(
      baseInput({
        deal: { ...baseInput().deal, stage: "MYSTERY" },
        rates: rates({ baseline: { won: 30, total: 100 } }),
      }),
    );

    expect(vector.values.stageProbability).toBeCloseTo(0.3, 12);
  });
});

describe("assembleDealFeatures – rep and source encoding", () => {
  const HISTORY = rates({
    baseline: { won: 40, total: 100 },
    byRep: new Map([["rep-1", { won: 8, total: 10 }]]),
    bySource: new Map([["referral", { won: 1, total: 10 }]]),
  });

  /**
   * Worked by hand. Baseline 40/100 = 0.4. Rep: (8 + 4) / (10 + 10) = 0.6.
   * Source: (1 + 4) / (10 + 10) = 0.25.
   */
  it("encodes a rep and a source as their own smoothed history", () => {
    const vector = assembleDealFeatures(baseInput({ rates: HISTORY }));

    expect(vector.values.repWinRate).toBeCloseTo(0.6, 12);
    expect(vector.values.sourceWinRate).toBeCloseTo(0.25, 12);
  });

  it("gives an unassigned or unsourced deal the tenant's base rate", () => {
    const vector = assembleDealFeatures(
      baseInput({
        deal: { ...baseInput().deal, assignedToId: null, sourceKey: null },
        rates: HISTORY,
      }),
    );

    expect(vector.values.repWinRate).toBeCloseTo(0.4, 12);
    expect(vector.values.sourceWinRate).toBeCloseTo(0.4, 12);
  });

  /**
   * The leak this exists to stop: a training example whose own outcome is inside
   * its own REP's counts would be told the answer through that rep's rate.
   *
   * The prior it is smoothed towards is the whole organisation's rate, and that
   * one keeps the example in. Removing it there is what the test below refuses.
   *
   * Worked by hand for a won deal. Prior stays 40/100 = 0.4.
   * Rep becomes (8 - 1 + 0.4 x 10) / (10 - 1 + 10) = 11/19.
   * Source becomes (1 - 1 + 4) / 19.
   */
  it("leaves a training example's own outcome out of its own encoding", () => {
    const vector = assembleDealFeatures(baseInput({ rates: HISTORY, ownOutcome: "won" }));
    const prior = 40 / 100;

    expect(vector.values.repWinRate).toBeCloseTo((7 + prior * 10) / 19, 12);
    expect(vector.values.sourceWinRate).toBeCloseTo((0 + prior * 10) / 19, 12);
  });

  it("leaves a lost training example out too", () => {
    const vector = assembleDealFeatures(baseInput({ rates: HISTORY, ownOutcome: "lost" }));
    const prior = 40 / 100;

    expect(vector.values.repWinRate).toBeCloseTo((8 + prior * 10) / 19, 12);
    expect(vector.values.sourceWinRate).toBeCloseTo((1 + prior * 10) / 19, 12);
  });

  /**
   * The prior must NOT be leave-one-out, and this is the assertion that says so.
   *
   * The baseline is one group per organisation, so removing the row's own
   * outcome would leave the prior with exactly two values across the whole
   * training set — one per label — and a linear model separates on that
   * perfectly while learning nothing. The held-out rows carry the same encoding,
   * so `FORECAST_ACCEPTANCE` cannot catch it: the model clears `minAuc` and beats
   * naive on Brier having read the answer key.
   *
   * Two won and two lost examples, identical but for their outcome and rep. If
   * the prior ever goes back to leave-one-out, the two won rows and the two lost
   * rows stop agreeing and this fails.
   */
  it("gives the same prior to a won and a lost example, so it cannot encode the label", () => {
    const flat = rates({
      baseline: { won: 40, total: 100 },
      byRep: new Map([["rep-1", { won: 5, total: 10 }]]),
      bySource: new Map([["referral", { won: 5, total: 10 }]]),
    });

    const won = assembleDealFeatures(baseInput({ rates: flat, ownOutcome: "won" }));
    const lost = assembleDealFeatures(baseInput({ rates: flat, ownOutcome: "lost" }));
    const serving = assembleDealFeatures(baseInput({ rates: flat, ownOutcome: null }));

    /**
     * Each still differs by its own rep count being decremented — that is the
     * legitimate leave-one-out. What must not differ is the prior underneath,
     * so it is read back by undoing the rep arithmetic.
     */
    const priorFrom = (repWinRate: number, ownWon: 0 | 1, hasOwn: 0 | 1): number =>
      (repWinRate * (10 - hasOwn + 10) - (5 - ownWon)) / 10;

    expect(priorFrom(won.values.repWinRate, 1, 1)).toBeCloseTo(0.4, 12);
    expect(priorFrom(lost.values.repWinRate, 0, 1)).toBeCloseTo(0.4, 12);
    expect(priorFrom(serving.values.repWinRate, 0, 0)).toBeCloseTo(0.4, 12);
  });

  it("cannot be driven below zero by leaving out the only example there was", () => {
    const vector = assembleDealFeatures(
      baseInput({
        rates: rates({
          baseline: { won: 1, total: 1 },
          byRep: new Map([["rep-1", { won: 1, total: 1 }]]),
        }),
        ownOutcome: "won",
      }),
    );

    expect(vector.values.repWinRate).toBeGreaterThanOrEqual(0);
    expect(vector.values.repWinRate).toBeLessThanOrEqual(1);
    expect(Number.isFinite(vector.values.repWinRate)).toBe(true);
  });
});
