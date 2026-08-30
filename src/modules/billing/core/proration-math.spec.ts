import { ROUNDING_RULES, computeProrationMinor, prorationFraction, type RoundingRule } from "./proration-math";

const PERIOD = {
  periodStart: new Date("2026-01-01T00:00:00Z"),
  periodEnd: new Date("2026-02-01T00:00:00Z"),
};

function compute(overrides: Partial<Parameters<typeof computeProrationMinor>[0]> = {}) {
  return computeProrationMinor({
    oldUnitAmountMinor: 0,
    oldQuantity: 1,
    newUnitAmountMinor: 0,
    newQuantity: 1,
    effectiveFrom: PERIOD.periodStart,
    effectiveUntil: PERIOD.periodEnd,
    ...PERIOD,
    roundingRule: "HALF_UP",
    ...overrides,
  });
}

describe("prorationFraction", () => {
  it("is the whole period when the change covers it end to end", () => {
    expect(prorationFraction({ ...PERIOD, effectiveFrom: PERIOD.periodStart, effectiveUntil: PERIOD.periodEnd })).toBe(1);
  });

  it("is half the period at the midpoint", () => {
    expect(
      prorationFraction({
        ...PERIOD,
        effectiveFrom: new Date("2026-01-16T12:00:00Z"),
        effectiveUntil: PERIOD.periodEnd,
      }),
    ).toBeCloseTo(0.5, 6);
  });

  it("is zero when the interval is empty", () => {
    expect(
      prorationFraction({ ...PERIOD, effectiveFrom: PERIOD.periodEnd, effectiveUntil: PERIOD.periodEnd }),
    ).toBe(0);
  });

  it("refuses a period of zero length rather than dividing by zero", () => {
    expect(() =>
      prorationFraction({
        periodStart: PERIOD.periodStart,
        periodEnd: PERIOD.periodStart,
        effectiveFrom: PERIOD.periodStart,
        effectiveUntil: PERIOD.periodStart,
      }),
    ).toThrow(/period/i);
  });

  it("refuses an interval that runs backwards", () => {
    expect(() =>
      prorationFraction({ ...PERIOD, effectiveFrom: PERIOD.periodEnd, effectiveUntil: PERIOD.periodStart }),
    ).toThrow(/before/i);
  });

  it("refuses an interval outside the period rather than billing more than a full period", () => {
    expect(() =>
      prorationFraction({
        ...PERIOD,
        effectiveFrom: new Date("2025-12-01T00:00:00Z"),
        effectiveUntil: PERIOD.periodEnd,
      }),
    ).toThrow(/outside/i);
  });
});

describe("computeProrationMinor", () => {
  it("charges the full difference when the change covers the whole period", () => {
    expect(compute({ oldUnitAmountMinor: 1000, newUnitAmountMinor: 3000 })).toBe(2000);
  });

  it("charges half the difference at the midpoint of the period", () => {
    expect(
      compute({
        oldUnitAmountMinor: 1000,
        newUnitAmountMinor: 3000,
        effectiveFrom: new Date("2026-01-16T12:00:00Z"),
      }),
    ).toBe(1000);
  });

  it("returns a negative amount for a downgrade, so the credit is a fact and not a sign convention", () => {
    expect(compute({ oldUnitAmountMinor: 3000, newUnitAmountMinor: 1000 })).toBe(-2000);
  });

  it("multiplies by quantity, so a seat change at an unchanged unit price still prorates", () => {
    expect(compute({ oldUnitAmountMinor: 1000, newUnitAmountMinor: 1000, oldQuantity: 5, newQuantity: 5 })).toBe(0);
    expect(compute({ oldUnitAmountMinor: 1000, newUnitAmountMinor: 1000, oldQuantity: 5, newQuantity: 8 })).toBe(3000);
    expect(compute({ oldUnitAmountMinor: 1000, newUnitAmountMinor: 1000, oldQuantity: 8, newQuantity: 5 })).toBe(-3000);
  });

  it("prices a change of both unit price and quantity from the two sides, not from a delta", () => {
    expect(
      compute({ oldUnitAmountMinor: 1000, oldQuantity: 10, newUnitAmountMinor: 3000, newQuantity: 4 }),
    ).toBe(2000);
  });

  it("stays exact past Number.MAX_SAFE_INTEGER in the intermediate product", () => {
    const result = compute({
      oldUnitAmountMinor: 0,
      newUnitAmountMinor: 2_000_000,
      newQuantity: 1000,
      effectiveFrom: new Date("2026-01-16T12:00:00Z"),
    });
    expect(result).toBe(1_000_000_000);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("never produces a fractional minor unit", () => {
    const result = compute({
      oldUnitAmountMinor: 0,
      newUnitAmountMinor: 999,
      effectiveFrom: new Date("2026-01-11T07:13:29Z"),
    });
    expect(Number.isInteger(result)).toBe(true);
  });

  describe("rounding is deterministic at the line level", () => {
    const HALF_UP_CASES: [RoundingRule, number][] = [
      ["HALF_UP", 3],
      ["HALF_EVEN", 2],
      ["FLOOR", 2],
      ["CEILING", 3],
    ];

    it.each(HALF_UP_CASES)("%s resolves an exact half to %i", (roundingRule, expected) => {
      expect(
        compute({
          oldUnitAmountMinor: 0,
          newUnitAmountMinor: 5,
          effectiveFrom: new Date("2026-01-16T12:00:00Z"),
          roundingRule,
        }),
      ).toBe(expected);
    });

    const NEGATIVE_HALF_CASES: [RoundingRule, number][] = [
      ["HALF_UP", -3],
      ["HALF_EVEN", -2],
      ["FLOOR", -3],
      ["CEILING", -2],
    ];

    it.each(NEGATIVE_HALF_CASES)("%s resolves a negative exact half to %i", (roundingRule, expected) => {
      expect(
        compute({
          oldUnitAmountMinor: 5,
          newUnitAmountMinor: 0,
          effectiveFrom: new Date("2026-01-16T12:00:00Z"),
          roundingRule,
        }),
      ).toBe(expected);
    });

    it("gives the same answer every time for the same inputs", () => {
      const args = {
        oldUnitAmountMinor: 1234,
        newUnitAmountMinor: 5678,
        oldQuantity: 3,
        newQuantity: 7,
        effectiveFrom: new Date("2026-01-09T03:41:07Z"),
        roundingRule: "HALF_EVEN" as const,
      };
      const first = compute(args);
      expect(compute(args)).toBe(first);
      expect(compute(args)).toBe(first);
    });

    it("covers every rounding rule the schema accepts", () => {
      for (const rule of ROUNDING_RULES) expect(rule.length).toBeLessThanOrEqual(10);
      expect([...ROUNDING_RULES].sort()).toEqual(["CEILING", "FLOOR", "HALF_EVEN", "HALF_UP"]);
    });
  });

  it("refuses a negative quantity rather than inverting the sign of the adjustment", () => {
    expect(() => compute({ newQuantity: -1 })).toThrow(/quantity/i);
    expect(() => compute({ oldQuantity: -1 })).toThrow(/quantity/i);
  });

  it("refuses an amount that would not survive the integer column", () => {
    expect(() =>
      compute({ oldUnitAmountMinor: 0, newUnitAmountMinor: 2_000_000_000, newQuantity: 1000 }),
    ).toThrow(/range/i);
  });
});
