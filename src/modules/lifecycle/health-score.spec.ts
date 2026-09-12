import {
  BPS_SCALE,
  DEFAULT_HEALTH_WEIGHTS_BPS,
  HEALTH_WEIGHTS_VERSION,
  MIN_HEALTH_COVERAGE_BPS,
  apportionBps,
  compositeHealth,
  healthBandOf,
  type HealthFactor,
} from "./health-score";
import { HEALTH_FACTOR_KEYS, type HealthFactorKey } from "../../db/schema/crm/lifecycle";

/**
 * The composite is a pure function, so these are the only tests that can hold
 * it to anything. Each one names the way a health score lies when the property
 * it asserts is broken.
 */

const WINDOW = {
  days: 90,
  from: new Date("2026-06-01T00:00:00.000Z"),
  to: new Date("2026-08-30T00:00:00.000Z"),
};

function measured(key: HealthFactorKey, value: number, weightBps?: number): HealthFactor {
  return {
    key,
    weightBps: weightBps ?? DEFAULT_HEALTH_WEIGHTS_BPS[key],
    window: WINDOW,
    status: "measured",
    value,
    observations: 3,
    detail: {},
  };
}

function missing(key: HealthFactorKey, weightBps?: number): HealthFactor {
  return {
    key,
    weightBps: weightBps ?? DEFAULT_HEALTH_WEIGHTS_BPS[key],
    window: WINDOW,
    status: "missing",
    reason: "no-observations",
    detail: {},
  };
}

describe("the declared weight table", () => {
  /**
   * A weight table that sums to 9800 deflates every score by two percent and
   * nothing else in the system would notice — the scores stay in range, the
   * bands still resolve, and every customer just looks slightly worse than they
   * are. This is the only place that can catch it.
   */
  it("sums to exactly one whole", () => {
    const total = Object.values(DEFAULT_HEALTH_WEIGHTS_BPS).reduce((a, b) => a + b, 0);
    expect(total).toBe(BPS_SCALE);
  });

  /** A key with no weight is an input that silently stopped counting. */
  it("gives every input in the vocabulary a weight", () => {
    expect(Object.keys(DEFAULT_HEALTH_WEIGHTS_BPS).sort()).toEqual(
      [...HEALTH_FACTOR_KEYS].sort(),
    );
  });
});

describe("apportionBps", () => {
  /**
   * Three equal weights round to 3333 each and sum to 9999. One basis point
   * short sounds harmless and is not: the decomposition then fails to
   * reconstruct the score it is supposed to explain, and a reader who adds the
   * parts up and gets a different number stops trusting the parts.
   */
  it("hands out every basis point even when the split does not divide", () => {
    expect(apportionBps([1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(apportionBps([1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(BPS_SCALE);
  });

  it("gives a single input the whole", () => {
    expect(apportionBps([2500])).toEqual([BPS_SCALE]);
  });

  /** No measured inputs must not produce NaN weights on the way to a null score. */
  it("returns nothing to apportion when there is nothing measured", () => {
    expect(apportionBps([])).toEqual([]);
    expect(apportionBps([0, 0])).toEqual([0, 0]);
  });

  /**
   * Ties break on position. Without a deterministic tiebreak the leftover basis
   * point lands on whichever input the sort happened to see first, and the same
   * customer scores 61 or 62 depending on which query returned first.
   */
  it("is deterministic under ties", () => {
    expect(apportionBps([1, 1, 1, 1, 1, 1, 1])).toEqual(
      apportionBps([1, 1, 1, 1, 1, 1, 1]),
    );
    expect(apportionBps([1, 1, 1, 1, 1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(BPS_SCALE);
  });
});

describe("compositeHealth with every input present", () => {
  const composite = compositeHealth([
    measured("usage", 40),
    measured("engagement", 80),
    measured("support", 100),
    measured("sentiment", 50),
  ]);

  it("is the declared weighted mean", () => {
    // 40*3500 + 80*2500 + 100*2500 + 50*1500 = 665_000 → 66.5 → 67
    expect(composite.score).toBe(67);
    expect(composite.band).toBe("at_risk");
  });

  it("reports full coverage and leaves the declared weights alone", () => {
    expect(composite.coverageBps).toBe(BPS_SCALE);
    for (const factor of composite.factors) {
      expect(factor.effectiveWeightBps).toBe(DEFAULT_HEALTH_WEIGHTS_BPS[factor.key]);
    }
  });

  /**
   * The property the whole feature rests on. If the contributions do not
   * reconstruct the score, the breakdown is a decoration rather than an
   * explanation, and somebody will eventually act on the difference.
   */
  it("reconstructs exactly from its own parts", () => {
    const summed = composite.factors.reduce((sum, f) => sum + f.contributionBps, 0);
    expect(Math.round(summed / BPS_SCALE)).toBe(composite.score);
  });

  it("stamps the weights version it was scored under", () => {
    expect(composite.weightsVersion).toBe(HEALTH_WEIGHTS_VERSION);
  });
});

describe("compositeHealth when an input is missing", () => {
  /**
   * THE test. A missing input scored as zero would drag this to 52; a missing
   * input scored as a neutral 50 — which is what `cs-health.service.ts` does —
   * would drag it to 69. Neither is a claim the data supports: three inputs all
   * said 80, so the model's answer is 80 and its coverage says how much of the
   * model that was.
   */
  it("redistributes the missing weight instead of scoring it", () => {
    const composite = compositeHealth([
      missing("usage"),
      measured("engagement", 80),
      measured("support", 80),
      measured("sentiment", 80),
    ]);

    expect(composite.score).toBe(80);
    expect(composite.coverageBps).toBe(6500);
    expect(composite.coverageBps).toBeLessThan(BPS_SCALE);
  });

  /**
   * The twin of `chk_customer_health_factors_missing_weightless`. A missing
   * factor carrying weight or points is the same bug as scoring it zero,
   * arriving through the decomposition instead of through the score.
   */
  it("gives a missing input no weight and no points", () => {
    const composite = compositeHealth([
      missing("usage"),
      measured("engagement", 80),
      measured("support", 80),
      measured("sentiment", 80),
    ]);

    const usage = composite.factors.find((f) => f.key === "usage");
    expect(usage?.status).toBe("missing");
    expect(usage?.effectiveWeightBps).toBe(0);
    expect(usage?.contributionBps).toBe(0);
  });

  /** The measured inputs keep their ratios to each other; only the base changes. */
  it("keeps the surviving inputs in proportion", () => {
    const composite = compositeHealth([
      missing("sentiment"),
      measured("usage", 100),
      measured("engagement", 0),
      measured("support", 0),
    ]);

    // usage 3500 of the surviving 8500 → 4118 bp, so 100 * 0.4118 ≈ 41
    expect(composite.coverageBps).toBe(8500);
    const effective = composite.factors
      .filter((f) => f.status === "measured")
      .reduce((sum, f) => sum + f.effectiveWeightBps, 0);
    expect(effective).toBe(BPS_SCALE);
    expect(composite.score).toBe(41);
  });

  it("still reconstructs from its parts", () => {
    const composite = compositeHealth([
      missing("usage"),
      missing("sentiment"),
      measured("engagement", 73),
      measured("support", 41),
    ]);
    const summed = composite.factors.reduce((sum, f) => sum + f.contributionBps, 0);
    expect(Math.round(summed / BPS_SCALE)).toBe(composite.score);
  });
});

describe("compositeHealth when too little of the model spoke", () => {
  /**
   * A composite resting on one of four inputs is a number with false precision,
   * and false precision is what leaves a customer alone until they cancel. Null
   * is the honest answer and the unscored list is the actionable part of it.
   */
  it("refuses to score below the coverage floor", () => {
    const composite = compositeHealth([
      missing("usage"),
      missing("engagement"),
      missing("support"),
      measured("sentiment", 100),
    ]);

    expect(composite.score).toBeNull();
    expect(composite.band).toBeNull();
    expect(composite.coverageBps).toBe(1500);
    expect(composite.unscored?.reason).toBe("insufficient-coverage");
    expect(composite.unscored?.missing.map((m) => m.key).sort()).toEqual([
      "engagement",
      "support",
      "usage",
    ]);
  });

  /** Exactly at the floor is enough. A boundary nobody tests is a boundary that moves. */
  it("scores exactly at the floor", () => {
    const composite = compositeHealth([
      missing("usage"),
      measured("engagement", 60, MIN_HEALTH_COVERAGE_BPS),
      missing("support"),
      missing("sentiment"),
    ]);

    expect(composite.coverageBps).toBe(MIN_HEALTH_COVERAGE_BPS);
    expect(composite.score).toBe(60);
  });

  /** Nothing measured at all must produce a null score, not a divide by zero. */
  it("survives every input being missing", () => {
    const composite = compositeHealth(HEALTH_FACTOR_KEYS.map((key) => missing(key)));
    expect(composite.score).toBeNull();
    expect(composite.coverageBps).toBe(0);
    expect(composite.factors).toHaveLength(HEALTH_FACTOR_KEYS.length);
  });
});

describe("compositeHealth housekeeping", () => {
  /**
   * Canonical order, not the caller's. Two assessments of the same customer
   * rendering their inputs in different orders — because two queries came back
   * in a different order — reads as the model having changed.
   */
  it("returns the inputs in the vocabulary's order whatever order they arrive in", () => {
    const composite = compositeHealth([
      measured("sentiment", 10),
      measured("support", 20),
      measured("engagement", 30),
      measured("usage", 40),
    ]);
    expect(composite.factors.map((f) => f.key)).toEqual([...HEALTH_FACTOR_KEYS]);
  });

  /**
   * A value outside 0..100 would violate the factor column's CHECK and, worse,
   * would put the score outside the band vocabulary — where it renders as
   * nothing at all on every surface that colours by one.
   */
  it("clamps a value the caller got wrong rather than propagating it", () => {
    const composite = compositeHealth([
      measured("usage", 400),
      measured("engagement", -50),
      measured("support", 100),
      measured("sentiment", 100),
    ]);
    const values = composite.factors.map((f) =>
      f.status === "measured" ? f.value : null,
    );
    expect(values).toEqual([100, 0, 100, 100]);
    expect(composite.score).toBeLessThanOrEqual(100);
    expect(composite.score).toBeGreaterThanOrEqual(0);
  });

  it("bands on the thresholds the party column's enum uses", () => {
    expect(healthBandOf(100)).toBe("healthy");
    expect(healthBandOf(70)).toBe("healthy");
    expect(healthBandOf(69)).toBe("at_risk");
    expect(healthBandOf(40)).toBe("at_risk");
    expect(healthBandOf(39)).toBe("critical");
    expect(healthBandOf(0)).toBe("critical");
  });
});
