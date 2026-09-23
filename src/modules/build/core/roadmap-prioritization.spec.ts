import {
  computeRoadmapPrioritization,
  RICE_CONFIDENCE_MAX,
  RICE_CONFIDENCE_MIN,
  RICE_CONFIDENCE_SCALE,
  RICE_EFFORT_MAX,
  RICE_EFFORT_MIN,
  RICE_IMPACT_MAX,
  RICE_IMPACT_MIN,
  RICE_INPUT_NAMES,
  RICE_METHOD,
  RICE_REACH_MAX,
  RICE_REACH_MIN,
  RICE_SCORE_DECIMALS,
} from "./roadmap-prioritization";
import { createRoadmapSchema, updateRoadmapSchema } from "./dto/roadmap.schemas";

describe("computeRoadmapPrioritization — RICE maths", () => {
  it("returns reach x impact x confidence/100 / effort when every input is present", () => {
    const result = computeRoadmapPrioritization({
      reach: 1000,
      impact: 3,
      confidence: 80,
      effort: 4,
    });
    expect(result.score).toBe(600);
    expect(result.isComplete).toBe(true);
    expect(result.unavailableReason).toBeNull();
    expect(result.missingInputs).toEqual([]);
    expect(result.method).toBe(RICE_METHOD);
  });

  it("divides confidence by RICE_CONFIDENCE_SCALE rather than treating it as a raw multiplier", () => {
    const scaled = computeRoadmapPrioritization({ reach: 10, impact: 1, confidence: 50, effort: 1 });
    expect(scaled.score).toBe((10 * 1 * (50 / RICE_CONFIDENCE_SCALE)) / 1);
    expect(scaled.score).not.toBe(10 * 1 * 50);
  });

  it("rounds to RICE_SCORE_DECIMALS so the score is never presented at false precision", () => {
    const result = computeRoadmapPrioritization({ reach: 10, impact: 1, confidence: 100, effort: 3 });
    expect(result.score).toBe(3.33);
    expect(String(result.score).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(RICE_SCORE_DECIMALS);
  });
});

describe("computeRoadmapPrioritization — a score is never authoritative when its inputs are missing", () => {
  it.each(RICE_INPUT_NAMES)("withholds the score and names %s when that single input is null", (missing) => {
    const complete: Record<string, number> = { reach: 100, impact: 2, confidence: 50, effort: 2 };
    const result = computeRoadmapPrioritization({ ...complete, [missing]: null });
    expect(result.score).toBeNull();
    expect(result.isComplete).toBe(false);
    expect(result.unavailableReason).toBe("missing_inputs");
    expect(result.missingInputs).toEqual([missing]);
  });

  it("names every missing input when the row has never been scored at all", () => {
    const result = computeRoadmapPrioritization({});
    expect(result.score).toBeNull();
    expect(result.isComplete).toBe(false);
    expect(result.missingInputs).toEqual([...RICE_INPUT_NAMES]);
  });

  it("treats undefined the same as null so a partially projected row cannot fake a complete score", () => {
    const result = computeRoadmapPrioritization({ reach: 100, impact: 2, confidence: 50 });
    expect(result.score).toBeNull();
    expect(result.missingInputs).toEqual(["effort"]);
  });

  it("treats NaN as missing rather than propagating NaN into the score", () => {
    const result = computeRoadmapPrioritization({ reach: Number.NaN, impact: 2, confidence: 50, effort: 2 });
    expect(result.score).toBeNull();
    expect(result.missingInputs).toEqual(["reach"]);
  });
});

describe("computeRoadmapPrioritization — effort is a divisor, so zero must not produce Infinity", () => {
  it("returns a null score with non_positive_effort instead of dividing by zero", () => {
    const result = computeRoadmapPrioritization({ reach: 100, impact: 2, confidence: 50, effort: 0 });
    expect(result.score).toBeNull();
    expect(result.unavailableReason).toBe("non_positive_effort");
    expect(result.isComplete).toBe(false);
    expect(result.missingInputs).toEqual([]);
  });

  it("returns a null score for negative effort rather than a negative priority", () => {
    const result = computeRoadmapPrioritization({ reach: 100, impact: 2, confidence: 50, effort: -3 });
    expect(result.score).toBeNull();
    expect(result.unavailableReason).toBe("non_positive_effort");
  });

  it("still scores the smallest legal effort, proving the zero guard is not swallowing every row", () => {
    const result = computeRoadmapPrioritization({ reach: 100, impact: 2, confidence: 50, effort: RICE_EFFORT_MIN });
    expect(result.score).toBe(100);
    expect(result.isComplete).toBe(true);
  });
});

describe("createRoadmapSchema — the four RICE inputs are accepted, which they were not before", () => {
  it("accepts reach, impact, confidence and effort on create", () => {
    const parsed = createRoadmapSchema.parse({
      title: "Bulk import",
      reach: 500,
      impact: 3,
      confidence: 80,
      effort: 5,
    });
    expect(parsed).toMatchObject({ reach: 500, impact: 3, confidence: 80, effort: 5 });
  });

  it("still rejects an unknown key, proving .strict() survived the widening", () => {
    expect(() =>
      createRoadmapSchema.parse({ title: "Bulk import", riceScore: 120 }),
    ).toThrow();
  });

  it("rejects a reach above RICE_REACH_MAX and below RICE_REACH_MIN", () => {
    expect(() => createRoadmapSchema.parse({ title: "x", reach: RICE_REACH_MAX + 1 })).toThrow();
    expect(() => createRoadmapSchema.parse({ title: "x", reach: RICE_REACH_MIN - 1 })).toThrow();
    expect(() => createRoadmapSchema.parse({ title: "x", reach: RICE_REACH_MAX })).not.toThrow();
  });

  it("rejects an impact outside the RICE impact ladder", () => {
    expect(() => createRoadmapSchema.parse({ title: "x", impact: RICE_IMPACT_MAX + 1 })).toThrow();
    expect(() => createRoadmapSchema.parse({ title: "x", impact: RICE_IMPACT_MIN - 1 })).toThrow();
    expect(() => createRoadmapSchema.parse({ title: "x", impact: RICE_IMPACT_MIN })).not.toThrow();
  });

  it("rejects a confidence outside 0-100 because the score divides it by 100", () => {
    expect(() => createRoadmapSchema.parse({ title: "x", confidence: RICE_CONFIDENCE_MAX + 1 })).toThrow();
    expect(() => createRoadmapSchema.parse({ title: "x", confidence: RICE_CONFIDENCE_MIN - 1 })).toThrow();
    expect(() => createRoadmapSchema.parse({ title: "x", confidence: RICE_CONFIDENCE_MAX })).not.toThrow();
  });

  it("rejects effort of zero at the boundary so the divisor guard is never reached from a create", () => {
    expect(() => createRoadmapSchema.parse({ title: "x", effort: 0 })).toThrow();
    expect(() => createRoadmapSchema.parse({ title: "x", effort: RICE_EFFORT_MIN })).not.toThrow();
    expect(() => createRoadmapSchema.parse({ title: "x", effort: RICE_EFFORT_MAX + 1 })).toThrow();
  });

  it("rejects a fractional RICE input because the columns are integers", () => {
    expect(() => createRoadmapSchema.parse({ title: "x", reach: 1.5 })).toThrow();
  });
});

describe("updateRoadmapSchema — RICE inputs are clearable, not just settable", () => {
  it("accepts null for each RICE field so an operator can retract a guess", () => {
    const parsed = updateRoadmapSchema.parse({
      reach: null,
      impact: null,
      confidence: null,
      effort: null,
    });
    expect(parsed).toEqual({ reach: null, impact: null, confidence: null, effort: null });
  });

  it("accepts a value for each RICE field", () => {
    const parsed = updateRoadmapSchema.parse({ reach: 1, impact: 2, confidence: 3, effort: 4 });
    expect(parsed).toEqual({ reach: 1, impact: 2, confidence: 3, effort: 4 });
  });

  it("still rejects an unknown key on update, proving .strict() survived the widening", () => {
    expect(() => updateRoadmapSchema.parse({ riceScore: 12 })).toThrow();
  });

  it("applies the same bounds on update as on create", () => {
    expect(() => updateRoadmapSchema.parse({ effort: 0 })).toThrow();
    expect(() => updateRoadmapSchema.parse({ impact: RICE_IMPACT_MAX + 1 })).toThrow();
  });
});
