import {
  FORECAST_ACCEPTANCE,
  FORECAST_HISTORY_REQUIREMENT,
  acceptModel,
  assessForecastHistory,
} from "./forecast-cold-start";
import type { ForecastMetrics } from "./forecast-metrics";

function metrics(overrides: Partial<ForecastMetrics> = {}): ForecastMetrics {
  return {
    count: 40,
    brier: 0.18,
    logLoss: 0.55,
    auc: 0.78,
    calibrationError: 0.05,
    baseRate: 0.4,
    ...overrides,
  };
}

describe("assessForecastHistory", () => {
  it("refuses the twelve-example tenant the ticket exists for", () => {
    const readiness = assessForecastHistory({ won: 5, lost: 7 });

    expect(readiness.ready).toBe(false);
    expect(readiness.closedDeals).toBe(12);
    expect(readiness.closedDealsNeeded).toBe(48);
    expect(readiness.wonDealsNeeded).toBe(10);
    expect(readiness.lostDealsNeeded).toBe(8);
  });

  it("opens the learned forecast exactly at the floor, not before", () => {
    expect(assessForecastHistory({ won: 30, lost: 29 }).ready).toBe(false);
    expect(assessForecastHistory({ won: 30, lost: 30 }).ready).toBe(true);
  });

  /**
   * Sixty closed deals but only ten wins. The headline gap is zero and the real
   * answer is five — and they have to be wins, which is why the shortfall is the
   * larger of the two rather than the headline alone.
   */
  it("counts the outcome that is missing, not just the total", () => {
    const readiness = assessForecastHistory({ won: 10, lost: 50 });

    expect(readiness.closedDeals).toBe(60);
    expect(readiness.ready).toBe(false);
    expect(readiness.closedDealsNeeded).toBe(5);
    expect(readiness.wonDealsNeeded).toBe(5);
    expect(readiness.lostDealsNeeded).toBe(0);
  });

  it("reports nothing outstanding once the floor is cleared", () => {
    const readiness = assessForecastHistory({ won: 120, lost: 300 });

    expect(readiness).toEqual({
      ready: true,
      closedDeals: 420,
      wonDeals: 120,
      lostDeals: 300,
      minimumClosedDeals: FORECAST_HISTORY_REQUIREMENT.minClosedDeals,
      minimumPerOutcome: FORECAST_HISTORY_REQUIREMENT.minPerOutcome,
      closedDealsNeeded: 0,
      wonDealsNeeded: 0,
      lostDealsNeeded: 0,
    });
  });

  it("says the whole floor is outstanding for a tenant with no history at all", () => {
    const readiness = assessForecastHistory({ won: 0, lost: 0 });

    expect(readiness.closedDealsNeeded).toBe(60);
    expect(readiness.wonDealsNeeded).toBe(15);
    expect(readiness.lostDealsNeeded).toBe(15);
  });

  it("cannot be talked into readiness by negative or fractional counts", () => {
    expect(assessForecastHistory({ won: -100, lost: 1000 }).ready).toBe(false);
    expect(assessForecastHistory({ won: 14.9, lost: 100 }).ready).toBe(false);
  });
});

describe("acceptModel", () => {
  it("accepts a model that ranks well and is closer to the outcomes than the naive one", () => {
    expect(acceptModel(metrics({ brier: 0.16 }), metrics({ brier: 0.21 }), true)).toEqual({
      accepted: true,
    });
  });

  it("rejects a model that cannot tell two deals apart", () => {
    expect(
      acceptModel(metrics({ auc: FORECAST_ACCEPTANCE.minAuc - 0.01 }), metrics(), true),
    ).toEqual({ accepted: false, reason: "cannot-discriminate" });
  });

  it("rejects a model no better than the weighted pipeline the tenant already had", () => {
    expect(acceptModel(metrics({ brier: 0.22 }), metrics({ brier: 0.21 }), true)).toEqual({
      accepted: false,
      reason: "no-better-than-naive",
    });
  });

  it("rejects a fit that never settled", () => {
    expect(acceptModel(metrics(), metrics({ brier: 0.9 }), false)).toEqual({
      accepted: false,
      reason: "did-not-converge",
    });
  });

  it("rejects a model measured on too few deals to be measured at all", () => {
    expect(
      acceptModel(
        metrics({ count: FORECAST_ACCEPTANCE.minHoldoutDeals - 1 }),
        metrics(),
        true,
      ),
    ).toEqual({ accepted: false, reason: "no-holdout" });
  });

  it("accepts a tie on Brier, because the ranking is then the tie-break", () => {
    expect(acceptModel(metrics({ brier: 0.2 }), metrics({ brier: 0.2 }), true)).toEqual({
      accepted: true,
    });
  });
});
