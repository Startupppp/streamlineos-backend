import type { HealthInput } from "../../db/schema/crm/customer-lifecycle";
import type { HealthScoreThresholds, HealthScoreWeights } from "../../db/schema/crm/customer-success";
import {
  DEFAULT_HEALTH_WEIGHTS_BPS,
  MATERIAL_HEALTH_CHANGE_POINTS,
  healthSignals,
  healthTrend,
  healthWeightsFromConfig,
  scoreHealth,
  USAGE_FRESHNESS_DAYS,
  type HealthFacts,
  type HealthPoint,
} from "./health-score";

const NOW = new Date("2026-06-01T12:00:00Z");
const DAY_MS = 86_400_000;
const THRESHOLDS: HealthScoreThresholds = { healthy: 70, atRisk: 40 };

/** Every input present and perfect, so a test can remove exactly one of them. */
function perfectFacts(overrides: Partial<HealthFacts> = {}): HealthFacts {
  return {
    now: NOW,
    weightsBps: DEFAULT_HEALTH_WEIGHTS_BPS,
    thresholds: THRESHOLDS,
    usage: {
      observations: [
        { metricKey: "seats", observedValue: 100, expectedValue: 100, observedAt: NOW },
      ],
    },
    engagement: { lastActivityAt: NOW, countInWindow: 10, countInPriorWindow: 10 },
    support: {
      tickets: [
        {
          priority: "MEDIUM",
          openedAt: new Date(NOW.getTime() - 2 * 3_600_000),
          resolvedAt: new Date(NOW.getTime() - 3_600_000),
          slaDeadline: null,
        },
      ],
    },
    sentiment: { positive: 3, neutral: 0, negative: 0 },
    renewal: { daysToRenewal: 200 },
    ...overrides,
  };
}

function scored(facts: HealthFacts) {
  const outcome = scoreHealth(facts);
  if (!outcome.scored) throw new Error("expected a score");
  return outcome;
}

function inputsOf(outcome: ReturnType<typeof scored>): HealthInput[] {
  return outcome.contributions.filter((entry) => entry.available).map((entry) => entry.input);
}

describe("a health score decomposes into the inputs that produced it", () => {
  it("carries every input with the weight it was given, whether or not it had data", () => {
    const outcome = scored(perfectFacts({ usage: { observations: [] } }));

    expect(outcome.contributions.map((entry) => entry.input)).toEqual([
      "usage",
      "engagement",
      "support",
      "sentiment",
      "renewal",
    ]);
    expect(outcome.contributions.map((entry) => entry.weightBps)).toEqual([
      DEFAULT_HEALTH_WEIGHTS_BPS.usage,
      DEFAULT_HEALTH_WEIGHTS_BPS.engagement,
      DEFAULT_HEALTH_WEIGHTS_BPS.support,
      DEFAULT_HEALTH_WEIGHTS_BPS.sentiment,
      DEFAULT_HEALTH_WEIGHTS_BPS.renewal,
    ]);
  });

  it("can be rebuilt from its own decomposition without the facts it came from", () => {
    const outcome = scored(
      perfectFacts({
        sentiment: { positive: 1, neutral: 1, negative: 1 },
        renewal: { daysToRenewal: 30 },
      }),
    );

    const available = outcome.contributions.filter((entry) => entry.available);
    const weight = available.reduce((sum, entry) => sum + entry.weightBps, 0);
    const numerator = available.reduce(
      (sum, entry) => sum + (entry.scoreBps ?? 0) * entry.weightBps,
      0,
    );

    expect(Math.round(numerator / weight / 100)).toBe(outcome.score);
  });

  it("rounds once over the whole set rather than once per input", () => {
    // usage 33/100 = 3300bps at a quarter of the weight, support 2 of 3 tickets
    // met = 6667bps at three quarters. Rounding each input to whole points first
    // gives 33 and 67, which weight to 58.5 and then to 59.
    const outcome = scored({
      now: NOW,
      weightsBps: { usage: 2_500, engagement: 0, support: 7_500, sentiment: 0, renewal: 0 },
      thresholds: THRESHOLDS,
      usage: {
        observations: [
          { metricKey: "seats", observedValue: 33, expectedValue: 100, observedAt: NOW },
        ],
      },
      engagement: { lastActivityAt: null, countInWindow: 0, countInPriorWindow: 0 },
      support: {
        tickets: [
          { priority: "LOW", openedAt: hoursAgo(10), resolvedAt: hoursAgo(9), slaDeadline: null },
          { priority: "LOW", openedAt: hoursAgo(10), resolvedAt: hoursAgo(9), slaDeadline: null },
          { priority: "LOW", openedAt: hoursAgo(500), resolvedAt: hoursAgo(9), slaDeadline: null },
        ],
      },
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      renewal: { daysToRenewal: null },
    });

    expect(outcome.score).toBe(58);
  });
});

describe("an input nobody supplied is absent, never a zero", () => {
  it("scores a tenant with no usage data out of what exists", () => {
    const outcome = scored(perfectFacts({ usage: { observations: [] } }));

    // Everything measurable is perfect. Treating the missing usage as a zero
    // would have produced 75 and put a healthy customer on a watchlist.
    expect(outcome.score).toBe(100);
    expect(outcome.contributions.find((entry) => entry.input === "usage")).toMatchObject({
      available: false,
      scoreBps: null,
    });
  });

  it("labels the score as partial and says how much of the model was behind it", () => {
    const outcome = scored(perfectFacts({ usage: { observations: [] } }));

    expect(outcome.basis).toBe("partial");
    expect(outcome.coverageBps).toBe(10_000 - DEFAULT_HEALTH_WEIGHTS_BPS.usage);
  });

  it("labels a score built from everything as complete", () => {
    expect(scored(perfectFacts()).basis).toBe("complete");
    expect(scored(perfectFacts()).coverageBps).toBe(10_000);
  });

  it("treats usage nobody has reported for two months as absent rather than as a collapse", () => {
    const stale = new Date(NOW.getTime() - (USAGE_FRESHNESS_DAYS + 1) * DAY_MS);
    const outcome = scored(
      perfectFacts({
        usage: {
          observations: [
            { metricKey: "seats", observedValue: 0, expectedValue: 100, observedAt: stale },
          ],
        },
      }),
    );

    expect(outcome.score).toBe(100);
    expect(outcome.basis).toBe("partial");
  });

  it("refuses to score a customer nothing is known about", () => {
    const outcome = scoreHealth({
      now: NOW,
      weightsBps: DEFAULT_HEALTH_WEIGHTS_BPS,
      thresholds: THRESHOLDS,
      usage: { observations: [] },
      engagement: { lastActivityAt: null, countInWindow: 0, countInPriorWindow: 0 },
      support: { tickets: [] },
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      renewal: { daysToRenewal: null },
    });

    expect(outcome.scored).toBe(false);
  });

  it("does not let an empty timeline stand in for a silent customer", () => {
    const silent = scored(
      perfectFacts({ engagement: { lastActivityAt: daysAgo(120), countInWindow: 0, countInPriorWindow: 4 } }),
    );
    const unknown = scored(
      perfectFacts({ engagement: { lastActivityAt: null, countInWindow: 0, countInPriorWindow: 0 } }),
    );

    expect(silent.score).toBeLessThan(unknown.score);
    expect(unknown.contributions.find((entry) => entry.input === "engagement")?.available).toBe(false);
  });
});

describe("a tenant's saved weights keep working", () => {
  const legacy: HealthScoreWeights = { sla: 25, csat: 25, activity: 20, renewal: 15, tickets: 15 };

  it("folds the two support numbers into one and keeps every ratio the tenant chose", () => {
    const weights = healthWeightsFromConfig(legacy);

    // sla + tickets = 40, csat = 25, activity = 20, renewal = 15.
    expect(weights.support / weights.sentiment).toBeCloseTo(40 / 25, 3);
    expect(weights.engagement / weights.renewal).toBeCloseTo(20 / 15, 3);
  });

  it("gives usage a share so a tenant who later wires telemetry up is not counting it at zero", () => {
    expect(healthWeightsFromConfig(legacy).usage).toBe(DEFAULT_HEALTH_WEIGHTS_BPS.usage);
  });

  it("scores a tenant with no usage exactly as their own four weights would have", () => {
    const facts = perfectFacts({
      weightsBps: healthWeightsFromConfig(legacy),
      usage: { observations: [] },
      support: { tickets: [{ priority: "LOW", openedAt: hoursAgo(500), resolvedAt: hoursAgo(1), slaDeadline: null }] },
      sentiment: { positive: 0, neutral: 0, negative: 4 },
      renewal: { daysToRenewal: 45 },
    });

    const outcome = scored(facts);
    const weights = healthWeightsFromConfig(legacy);
    const byInput = new Map(outcome.contributions.map((entry) => [entry.input, entry]));

    const expected = Math.round(
      ((byInput.get("engagement")!.scoreBps! * weights.engagement +
        byInput.get("support")!.scoreBps! * weights.support +
        byInput.get("sentiment")!.scoreBps! * weights.sentiment +
        byInput.get("renewal")!.scoreBps! * weights.renewal) /
        (weights.engagement + weights.support + weights.sentiment + weights.renewal)) /
        100,
    );

    expect(outcome.score).toBe(expected);
  });

  it("falls back to the platform's weights rather than dividing by nothing", () => {
    expect(
      healthWeightsFromConfig({ sla: 0, csat: 0, activity: 0, renewal: 0, tickets: 0 }),
    ).toEqual(DEFAULT_HEALTH_WEIGHTS_BPS);
  });
});

describe("a score has a trend, not only a value", () => {
  const inputs: HealthInput[] = ["engagement", "support"];

  const point = (score: number, daysAgoTaken: number, available = inputs): HealthPoint => ({
    score,
    band: score >= 70 ? "healthy" : score >= 40 ? "at_risk" : "critical",
    coverageBps: 5_000,
    availableInputs: available,
    computedAt: new Date(NOW.getTime() - daysAgoTaken * DAY_MS),
  });

  it("reports a slide as a decline against the last comparable reading", () => {
    const trend = healthTrend([point(45, 0), point(62, 7), point(80, 30)]);

    expect(trend.direction).toBe("declining");
    expect(trend.deltaPoints).toBe(-17);
  });

  it("holds movement inside the noise band steady", () => {
    expect(healthTrend([point(61, 0), point(62, 7)]).direction).toBe("steady");
  });

  it("says it cannot tell rather than inventing a direction from one reading", () => {
    expect(healthTrend([point(61, 0)]).direction).toBe("unknown");
    expect(healthTrend([]).direction).toBe("unknown");
  });

  it("skips a reading built from different inputs instead of comparing against it", () => {
    const trend = healthTrend([point(45, 0), point(90, 7, ["engagement"]), point(50, 30)]);

    // The 90 came from a model with one input in it. Comparing against it would
    // report a 45-point collapse that never happened.
    expect(trend.deltaPoints).toBe(-5);
    expect(trend.comparedTo).toEqual(new Date(NOW.getTime() - 30 * DAY_MS));
  });
});

describe("a change large enough to matter produces a signal", () => {
  const inputs: HealthInput[] = ["engagement", "support", "renewal"];

  const point = (score: number, coverageBps = 6_000, available = inputs): HealthPoint => ({
    score,
    band: score >= 70 ? "healthy" : score >= 40 ? "at_risk" : "critical",
    coverageBps,
    availableInputs: available,
    computedAt: NOW,
  });

  it("says nothing about a customer's first score", () => {
    expect(healthSignals(null, point(30))).toEqual([]);
  });

  it("says nothing about movement inside the noise band", () => {
    expect(healthSignals(point(75), point(75 + MATERIAL_HEALTH_CHANGE_POINTS - 1))).toEqual([]);
  });

  it("reports a fall past the threshold, with both numbers behind it", () => {
    const [signal] = healthSignals(point(80), point(80 - MATERIAL_HEALTH_CHANGE_POINTS));

    expect(signal?.kind).toBe("health.dropped");
    expect(signal?.evidence).toMatchObject({ from: 80, to: 70, deltaPoints: -10 });
  });

  it("reports a recovery as its own kind, so a feed can tell the two apart", () => {
    expect(healthSignals(point(40), point(60))[0]?.kind).toBe("health.recovered");
  });

  it("reports a crossed band however small the step was", () => {
    const [signal] = healthSignals(point(70), point(69));

    expect(signal?.kind).toBe("health.band-changed");
    expect(signal?.summary).toContain("at_risk");
  });

  it("stays quiet when the model changed underneath the number", () => {
    const before = point(85, 10_000, ["engagement", "support", "renewal"]);
    const after = point(60, 6_000, ["engagement", "support"]);

    // Twenty-five points, and none of it is about the customer: an input stopped
    // reporting. Sending somebody to save this account would waste their day.
    expect(healthSignals(before, after)).toEqual([]);
  });
});

describe("support history is read per customer", () => {
  it("counts a ticket still inside its window as met rather than as a failure", () => {
    const outcome = scored(
      perfectFacts({
        support: {
          tickets: [{ priority: "LOW", openedAt: hoursAgo(1), resolvedAt: null, slaDeadline: null }],
        },
      }),
    );

    expect(outcome.contributions.find((entry) => entry.input === "support")?.scoreBps).toBe(10_000);
  });

  it("penalises a ticket that is open and already late", () => {
    const outcome = scored(
      perfectFacts({
        support: {
          tickets: [
            { priority: "URGENT", openedAt: hoursAgo(100), resolvedAt: null, slaDeadline: null },
          ],
        },
      }),
    );

    const support = outcome.contributions.find((entry) => entry.input === "support");
    expect(support?.scoreBps).toBe(0);
    expect(support?.evidence).toMatchObject({ overdueOpen: 1 });
  });

  it("keeps the inputs it used available for a reader who disagrees with the number", () => {
    expect(inputsOf(scored(perfectFacts()))).toEqual([
      "usage",
      "engagement",
      "support",
      "sentiment",
      "renewal",
    ]);
  });
});

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}
