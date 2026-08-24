import {
  needsHumanReview,
  normaliseSampleRate,
  samplingFraction,
  shouldShadowScore,
  type SamplingInput,
} from "./shadow-scoring";

const settings = { shadowSampleRate: 0.1, shadowDailyCap: 500 };

const input = (over: Partial<SamplingInput> = {}): SamplingInput => ({
  decisionId: "d-1",
  kind: "stage.advanced",
  outcome: "applied",
  confidence: 0.99,
  settings,
  scoredToday: 0,
  ...over,
});

describe("shouldShadowScore", () => {
  it("skips a decision that changed nothing", () => {
    for (const outcome of ["skipped", "failed", "held", "reversed"])
      expect(shouldShadowScore(input({ outcome })).score).toBe(false);
  });

  it("never scores routine filing", () => {
    // Deterministic and effectively always right — scoring it would spend the
    // cap on the one action type that cannot be wrong.
    const result = shouldShadowScore(input({ kind: "activity.logged" }));
    expect(result).toEqual({ score: false, reason: "routine" });
  });

  it("stops at the daily cap", () => {
    expect(shouldShadowScore(input({ scoredToday: 500 })).reason).toBe("daily-cap-reached");
    expect(shouldShadowScore(input({ scoredToday: 501 })).reason).toBe("daily-cap-reached");
    expect(
      shouldShadowScore(input({ settings: { ...settings, shadowDailyCap: 0 } })).reason,
    ).toBe("daily-cap-reached");
  });

  it("scores nothing when the rate is zero", () => {
    expect(
      shouldShadowScore(input({ settings: { ...settings, shadowSampleRate: 0 } })).score,
    ).toBe(false);
  });

  /**
   * The rule that earns the feature. A decision that cleared its threshold by a
   * hair is where the system is most likely to be wrong; leaving those to a 10%
   * dice roll spends the sample on the confident cases that were never in doubt.
   */
  it("always scores a decision that barely cleared its threshold", () => {
    // stage.advanced acts at 0.85.
    const result = shouldShadowScore(input({ confidence: 0.86 }));
    expect(result).toEqual({ score: true, reason: "near-threshold" });
  });

  it("leaves a confident decision to the sample", () => {
    expect(shouldShadowScore(input({ confidence: 0.99 })).reason).toMatch(/sampled/);
  });

  it("scores everything at a rate of one", () => {
    const all = { ...settings, shadowSampleRate: 1 };
    for (const id of ["a", "b", "c", "d", "e"])
      expect(shouldShadowScore(input({ decisionId: id, confidence: 0.99, settings: all })).score).toBe(true);
  });
});

describe("samplingFraction", () => {
  /**
   * Sampling is a property of the decision, not of the moment. With
   * `Math.random()` a replayed workflow could sample differently and try to
   * score work it already scored, which the unique index would then reject as a
   * conflict rather than recognise as a no-op.
   */
  it("is stable for the same id", () => {
    expect(samplingFraction("decision-abc")).toBe(samplingFraction("decision-abc"));
  });

  it("stays inside [0, 1)", () => {
    for (const id of ["", "a", "decision-abc", "x".repeat(200), "🙂"]) {
      const value = samplingFraction(id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("spreads roughly evenly, so a 10% rate samples about a tenth", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `decision-${i}`);
    const sampled = ids.filter((id) => samplingFraction(id) < 0.1).length;
    expect(sampled / ids.length).toBeGreaterThan(0.07);
    expect(sampled / ids.length).toBeLessThan(0.13);
  });
});

describe("needsHumanReview", () => {
  it("routes an outright disagreement", () => {
    expect(needsHumanReview("disagrees", 0.99, "stage.advanced")).toBe(true);
  });

  /**
   * A failed second pass says nothing about the decision — only that the scorer
   * broke. Routing it would fill the queue with provider outages and teach
   * people to clear the queue without reading it.
   */
  it("does not route a scorer failure", () => {
    expect(needsHumanReview("failed", 0.5, "stage.advanced")).toBe(false);
  });

  it("routes uncertainty only when the original was itself marginal", () => {
    expect(needsHumanReview("uncertain", 0.86, "stage.advanced")).toBe(true);
    expect(needsHumanReview("uncertain", 0.99, "stage.advanced")).toBe(false);
  });

  it("never routes agreement", () => {
    expect(needsHumanReview("agrees", 0.5, "stage.advanced")).toBe(false);
  });
});

describe("normaliseSampleRate", () => {
  it("clamps into range so a bad row cannot spend without limit", () => {
    expect(normaliseSampleRate(1.5)).toBe(1);
    expect(normaliseSampleRate(-0.2)).toBe(0);
    expect(normaliseSampleRate("0.250")).toBe(0.25);
  });

  it("treats anything unparseable as off rather than as full", () => {
    expect(normaliseSampleRate(null)).toBe(0);
    expect(normaliseSampleRate(undefined)).toBe(0);
    expect(normaliseSampleRate("banana")).toBe(0);
  });
});
