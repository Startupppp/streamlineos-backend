import { describe as summarise, inverseNormalCdf, safetyStock } from "../safety-stock";

describe("INV-303 inverse normal", () => {
  it("matches the textbook z-scores", () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 6);
    expect(inverseNormalCdf(0.95)).toBeCloseTo(1.6449, 3);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.96, 3);
    expect(inverseNormalCdf(0.99)).toBeCloseTo(2.3263, 3);
  });

  it("handles the far tails the approximation switches branches for", () => {
    expect(inverseNormalCdf(0.999)).toBeCloseTo(3.0902, 2);
    expect(inverseNormalCdf(0.001)).toBeCloseTo(-3.0902, 2);
  });

  it("refuses an impossible service level rather than returning infinity", () => {
    expect(() => inverseNormalCdf(0)).toThrow(RangeError);
    expect(() => inverseNormalCdf(1)).toThrow(RangeError);
  });
});

describe("INV-303 safety stock", () => {
  it("computes the textbook case", () => {
    // 100/period, sd 20, lead time 4 periods, reliable supplier, 95%.
    // sigma = 20 * sqrt(4) = 40; ss = 1.6449 * 40 = 65.8; rop = 400 + 65.8.
    const result = safetyStock({
      demandMean: 100,
      demandStdDev: 20,
      leadTimePeriods: 4,
      leadTimeStdDev: 0,
      serviceLevel: 0.95,
    });
    expect(result.safetyStock).toBeCloseTo(65.79, 1);
    expect(result.leadTimeDemand).toBe(400);
    expect(result.reorderPoint).toBeCloseTo(465.79, 1);
  });

  it("counts lead-time variability, which the common shortcut drops", () => {
    // The same demand, but the supplier is unreliable. The shortcut formula
    // would return the identical number and be badly too small.
    const reliable = safetyStock({
      demandMean: 100,
      demandStdDev: 20,
      leadTimePeriods: 4,
      leadTimeStdDev: 0,
      serviceLevel: 0.95,
    });
    const unreliable = safetyStock({
      demandMean: 100,
      demandStdDev: 20,
      leadTimePeriods: 4,
      leadTimeStdDev: 2,
      serviceLevel: 0.95,
    });
    expect(unreliable.safetyStock).toBeGreaterThan(reliable.safetyStock * 3);
    expect(unreliable.dominantVariance).toBe("lead_time");
  });

  it("says when demand variability is what dominates", () => {
    const result = safetyStock({
      demandMean: 10,
      demandStdDev: 30,
      leadTimePeriods: 4,
      leadTimeStdDev: 0.1,
      serviceLevel: 0.95,
    });
    expect(result.dominantVariance).toBe("demand");
  });

  it("warns that a zero lead-time deviation may be missing data", () => {
    // The difference between "this supplier is reliable" and "nobody measured"
    // is invisible in the number and decisive for the answer.
    const result = safetyStock({
      demandMean: 10,
      demandStdDev: 2,
      leadTimePeriods: 3,
      leadTimeStdDev: 0,
      serviceLevel: 0.95,
    });
    expect(result.warnings.join(" ")).toMatch(/perfectly reliable/);
  });

  it("warns that an extreme service level is an assumption, not a measurement", () => {
    const result = safetyStock({
      demandMean: 10,
      demandStdDev: 2,
      leadTimePeriods: 3,
      leadTimeStdDev: 1,
      serviceLevel: 0.9999,
    });
    expect(result.warnings.join(" ")).toMatch(/expensive guess/);
  });

  it("never returns a negative buffer", () => {
    // Below a 50% service level z goes negative, which would otherwise subtract
    // stock from the reorder point.
    const result = safetyStock({
      demandMean: 10,
      demandStdDev: 2,
      leadTimePeriods: 3,
      leadTimeStdDev: 0,
      serviceLevel: 0.2,
    });
    expect(result.safetyStock).toBe(0);
    expect(result.reorderPoint).toBe(result.leadTimeDemand);
  });
});

describe("INV-303 series statistics", () => {
  it("uses the sample deviation, not the population one", () => {
    // n-1. With n, a short history understates the spread on exactly the SKUs
    // where the history is short and the spread matters most.
    expect(summarise([2, 4, 4, 4, 5, 5, 7, 9].slice(0, 4)).stdDev).toBeCloseTo(1, 4);
  });

  it("reports a single observation as having no spread rather than NaN", () => {
    expect(summarise([5])).toEqual({ mean: 5, stdDev: 0 });
  });

  it("survives an empty series", () => {
    expect(summarise([])).toEqual({ mean: 0, stdDev: 0 });
  });
});
