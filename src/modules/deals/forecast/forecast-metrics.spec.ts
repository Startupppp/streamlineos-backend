import {
  brierScore,
  calibrationBuckets,
  chronologicalSplit,
  evaluate,
  expectedCalibrationError,
  logLoss,
  rocAuc,
  type Prediction,
} from "./forecast-metrics";

function p(probability: number, won: boolean): Prediction {
  return { probability, won };
}

describe("brierScore", () => {
  /** (0.9 − 1)² + (0.2 − 0)² = 0.01 + 0.04 = 0.05 over two deals is 0.025. */
  it("is the mean squared gap between the promise and the outcome", () => {
    expect(brierScore([p(0.9, true), p(0.2, false)])).toBeCloseTo(0.025, 12);
  });

  it("is zero for a forecast that was exactly right", () => {
    expect(brierScore([p(1, true), p(0, false)])).toBeCloseTo(0, 8);
  });

  /** Always saying 0.5 scores 0.25 whatever happens. The number to beat. */
  it("scores a quarter for a forecast that refuses to commit", () => {
    expect(brierScore([p(0.5, true), p(0.5, false), p(0.5, true)])).toBeCloseTo(0.25, 12);
  });

  it("is zero for an empty set rather than a division by zero", () => {
    expect(brierScore([])).toBe(0);
  });
});

describe("logLoss", () => {
  /** −ln(0.8) over one correct call. */
  it("is the mean negative log-likelihood", () => {
    expect(logLoss([p(0.8, true)])).toBeCloseTo(-Math.log(0.8), 12);
  });

  it("punishes a confident mistake without going to infinity", () => {
    const loss = logLoss([p(1, false)]);

    expect(Number.isFinite(loss)).toBe(true);
    expect(loss).toBeGreaterThan(10);
  });
});

describe("rocAuc", () => {
  it("is one when every won deal outranks every lost one", () => {
    expect(rocAuc([p(0.9, true), p(0.8, true), p(0.3, false), p(0.1, false)])).toBeCloseTo(1, 12);
  });

  it("is zero when the ranking is exactly backwards", () => {
    expect(rocAuc([p(0.1, true), p(0.2, true), p(0.8, false), p(0.9, false)])).toBeCloseTo(0, 12);
  });

  /** Every deal the same number is no ability to discriminate, not perfect skill. */
  it("is a half when the model says the same thing about everything", () => {
    expect(rocAuc([p(0.4, true), p(0.4, false), p(0.4, true), p(0.4, false)])).toBeCloseTo(0.5, 12);
  });

  /**
   * One won at 0.6, one lost at 0.6, one lost at 0.2. The won deal beats the
   * 0.2 outright and ties the other, so 1.5 of 2 comparisons: 0.75.
   */
  it("splits a tie down the middle", () => {
    expect(rocAuc([p(0.6, true), p(0.6, false), p(0.2, false)])).toBeCloseTo(0.75, 12);
  });

  it("is a half when there is nothing to compare", () => {
    expect(rocAuc([p(0.9, true), p(0.8, true)])).toBe(0.5);
  });
});

describe("calibration", () => {
  it("reports what was promised against what happened, per band", () => {
    const buckets = calibrationBuckets([p(0.85, true), p(0.85, false), p(0.15, false)]);
    const high = buckets[8];
    const low = buckets[1];

    expect(high?.count).toBe(2);
    expect(high?.predicted).toBeCloseTo(0.85, 12);
    expect(high?.observed).toBeCloseTo(0.5, 12);
    expect(low?.count).toBe(1);
    expect(low?.observed).toBe(0);
  });

  /**
   * Two deals promised 0.85 of which one won: a gap of 0.35 on two-thirds of the
   * set. One promised 0.15 that lost: a gap of 0.15 on a third.
   * (2/3)(0.35) + (1/3)(0.15) = 0.283333...
   */
  it("weights each band's gap by how many deals fell in it", () => {
    expect(expectedCalibrationError([p(0.85, true), p(0.85, false), p(0.15, false)])).toBeCloseTo(
      (2 / 3) * 0.35 + (1 / 3) * 0.15,
      10,
    );
  });

  it("reports no gap where the promise matched the outcome", () => {
    const buckets = calibrationBuckets([p(0.5, true), p(0.5, false), p(0.95, true)]);

    expect(buckets[5]?.observed).toBeCloseTo(0.5, 12);
    expect(buckets[5]?.predicted).toBeCloseTo(0.5, 12);
    expect(buckets[9]?.observed).toBe(1);
    expect(expectedCalibrationError([p(0.5, true), p(0.5, false)])).toBeCloseTo(0, 8);
  });
});

describe("evaluate", () => {
  it("carries the base rate alongside the scores, so they can be read against it", () => {
    const metrics = evaluate([p(0.9, true), p(0.2, false), p(0.7, true), p(0.4, false)]);

    expect(metrics.count).toBe(4);
    expect(metrics.baseRate).toBe(0.5);
    expect(metrics.auc).toBeCloseTo(1, 12);
  });

  it("returns zeroes rather than NaN for nothing at all", () => {
    const metrics = evaluate([]);

    expect(metrics).toEqual({
      count: 0,
      brier: 0,
      logLoss: 0,
      auc: 0.5,
      calibrationError: 0,
      baseRate: 0,
    });
  });
});

describe("chronologicalSplit", () => {
  const examples = Array.from({ length: 10 }, (_, i) => ({
    dealId: i + 1,
    closedAt: new Date(Date.UTC(2026, 0, i + 1)),
  }));

  it("trains on the older deals and judges on the newer ones", () => {
    const split = chronologicalSplit(examples, 0.3);

    expect(split.training.map((e) => e.dealId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(split.holdout.map((e) => e.dealId)).toEqual([8, 9, 10]);
  });

  it("orders identically whatever order the caller supplies", () => {
    const forwards = chronologicalSplit(examples, 0.3);
    const backwards = chronologicalSplit([...examples].reverse(), 0.3);

    expect(backwards.holdout.map((e) => e.dealId)).toEqual(forwards.holdout.map((e) => e.dealId));
  });

  it("breaks a same-day tie on deal id so the split never moves", () => {
    const sameDay = [3, 1, 2].map((dealId) => ({ dealId, closedAt: new Date(Date.UTC(2026, 0, 1)) }));

    expect(chronologicalSplit(sameDay, 0.34).holdout.map((e) => e.dealId)).toEqual([3]);
  });

  it("holds nothing back rather than one deal out of three", () => {
    expect(chronologicalSplit(examples.slice(0, 3), 0.1).holdout).toEqual([]);
  });
});
