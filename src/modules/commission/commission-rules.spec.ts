import type { CommissionRuleSet } from "../../db/schema/crm/commission";
import { assertRuleSet, evaluateCommission, periodWindow } from "./commission-rules";

/**
 * The arithmetic a payslip is defended with.
 *
 * Every case here names a way a commission engine gets money wrong quietly:
 * cliff-edged tiers, per-slice rounding, float overflow, a compounded
 * accelerator, a quota window that moves with the server's timezone. None of
 * them throw; all of them pay a number that looks plausible.
 */

const base: CommissionRuleSet = {
  basis: "deal_value",
  period: "MONTH",
  quotaMinor: 1_000_000, // 10,000.00 in minor units
  tiers: [
    { from: 0, rateBps: 500 }, // 5% up to quota
    { from: 10_000, rateBps: 1_000 }, // 10% above it
  ],
  accelerators: [],
  capMinor: null,
};

describe("evaluateCommission: tiers are marginal, not cliff-edged", () => {
  it("pays the entry rate on a basis that stays inside the first band", () => {
    const result = evaluateCommission(base, { basisMinor: 1_000_000, priorBasisMinor: 0 });

    expect(result.amountMinor).toBe(50_000);
    expect(result.attainmentBps).toBe(10_000);
  });

  /**
   * The failure: paying the top rate on the WHOLE basis because the earner
   * ended above quota. That makes 200% attainment pay 200,000 rather than
   * 150,000 here — a 33% overpay that no single row looks wrong in.
   */
  it("splits a basis that crosses quota, rather than repricing all of it", () => {
    const result = evaluateCommission(base, { basisMinor: 2_000_000, priorBasisMinor: 0 });

    expect(result.amountMinor).toBe(150_000);
    expect(result.slices).toHaveLength(2);
    expect(result.slices[0]).toMatchObject({ basisMinor: 1_000_000, rateBps: 500 });
    expect(result.slices[1]).toMatchObject({ basisMinor: 1_000_000, rateBps: 1_000 });
  });

  /**
   * The mirror failure: ignoring what the earner already booked, so every deal
   * restarts at the entry rate and a rep who blew through quota in January is
   * paid as though each deal were their first.
   */
  it("starts where the period's prior earnings left off", () => {
    const result = evaluateCommission(base, {
      basisMinor: 1_000_000,
      priorBasisMinor: 1_000_000,
    });

    expect(result.amountMinor).toBe(100_000);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]!.rateBps).toBe(1_000);
    expect(result.attainmentBps).toBe(20_000);
  });

  it("splits the same revenue identically however it arrives", () => {
    const whole = evaluateCommission(base, { basisMinor: 2_000_000, priorBasisMinor: 0 });
    const first = evaluateCommission(base, { basisMinor: 1_200_000, priorBasisMinor: 0 });
    const second = evaluateCommission(base, {
      basisMinor: 800_000,
      priorBasisMinor: 1_200_000,
    });

    // If this ever fails, a rep can be paid more by splitting one deal in two.
    expect(first.amountMinor + second.amountMinor).toBe(whole.amountMinor);
  });
});

describe("evaluateCommission: accelerators", () => {
  const accelerated: CommissionRuleSet = {
    ...base,
    accelerators: [{ aboveBps: 10_000, multiplierBps: 15_000 }],
  };

  it("multiplies only the slices at or above the threshold", () => {
    const result = evaluateCommission(accelerated, {
      basisMinor: 2_000_000,
      priorBasisMinor: 0,
    });

    // 50,000 below quota, then 100,000 x 1.5 above it.
    expect(result.amountMinor).toBe(200_000);
    expect(result.slices[0]!.multiplierBps).toBe(10_000);
    expect(result.slices[1]!.multiplierBps).toBe(15_000);
  });

  /**
   * The failure: multiplying every matching accelerator together. Two 1.25x
   * rows read as 1.25x on the plan document and would pay 1.5625x, which no
   * commission agreement has ever meant.
   */
  it("takes the highest matching multiplier, never the product", () => {
    const stacked: CommissionRuleSet = {
      ...base,
      accelerators: [
        { aboveBps: 10_000, multiplierBps: 12_500 },
        { aboveBps: 15_000, multiplierBps: 12_500 },
      ],
    };

    const result = evaluateCommission(stacked, {
      basisMinor: 2_000_000,
      priorBasisMinor: 1_000_000,
    });

    // Every slice sits above both thresholds; 1.25x, not 1.5625x.
    for (const slice of result.slices) expect(slice.multiplierBps).toBe(12_500);
    expect(result.amountMinor).toBe(250_000);
  });
});

describe("evaluateCommission: integer money", () => {
  /**
   * Rounding once, at the end.
   *
   * Two slices of half a minor unit each. Rounded per slice they display as 1
   * apiece and would total 2; the exact sum is 1. Asserting both numbers here
   * is the point — the slice figures are presentation, and the payout is not
   * their sum.
   */
  it("rounds the total once rather than rounding every slice", () => {
    const halves: CommissionRuleSet = {
      basis: "deal_value",
      period: "MONTH",
      quotaMinor: null,
      tiers: [
        { from: 0, rateBps: 5_000 },
        { from: 1, rateBps: 5_000 },
      ],
      accelerators: [],
      capMinor: null,
    };

    const result = evaluateCommission(halves, { basisMinor: 2, priorBasisMinor: 0 });

    expect(result.slices.map((s) => s.amountMinor)).toEqual([1, 1]);
    expect(result.amountMinor).toBe(1);
  });

  it("rounds a lone half away from zero", () => {
    const half: CommissionRuleSet = {
      basis: "deal_value",
      period: "MONTH",
      quotaMinor: null,
      tiers: [{ from: 0, rateBps: 5_000 }],
      accelerators: [],
      capMinor: null,
    };

    expect(
      evaluateCommission(half, { basisMinor: 1, priorBasisMinor: 0 }).amountMinor,
    ).toBe(1);
  });

  /**
   * The overflow this file uses BigInt for.
   *
   * basis x rate x multiplier here is ~1.1e21, twenty-odd times past
   * `Number.MAX_SAFE_INTEGER`. The naive `number` form of the same calculation
   * is asserted below to be wrong by exactly one minor unit — not to document
   * float trivia, but because that is a real, silently-wrong payout, and if
   * somebody "simplifies" the BigInt away this test says so instead of the
   * finance team saying so.
   */
  it("stays exact past Number.MAX_SAFE_INTEGER", () => {
    const large: CommissionRuleSet = {
      basis: "deal_value",
      period: "YEAR",
      quotaMinor: null,
      tiers: [{ from: 0, rateBps: 9_129 }],
      accelerators: [{ aboveBps: 0, multiplierBps: 18_659 }],
      capMinor: null,
    };
    const basisMinor = 6_553_921_205_434;

    const result = evaluateCommission(large, { basisMinor, priorBasisMinor: 0 });

    expect(result.amountMinor).toBe(11_163_819_023_843);
    expect(Math.round((basisMinor * 9_129 * 18_659) / 1e8)).toBe(11_163_819_023_844);
  });

  it("applies the cap and records that it did", () => {
    const capped: CommissionRuleSet = { ...base, capMinor: 60_000 };

    const result = evaluateCommission(capped, {
      basisMinor: 2_000_000,
      priorBasisMinor: 0,
    });

    expect(result.amountMinor).toBe(60_000);
    expect(result.capped).toBe(true);
  });

  it("measures against the person's own quota when the assignment overrides it", () => {
    // Same rules, half the quota: the band boundary halves with it.
    const result = evaluateCommission(base, {
      basisMinor: 1_000_000,
      priorBasisMinor: 0,
      quotaOverrideMinor: 500_000,
    });

    expect(result.quotaMinor).toBe(500_000);
    expect(result.attainmentBps).toBe(20_000);
    // 500,000 at 5% then 500,000 at 10%.
    expect(result.amountMinor).toBe(75_000);
  });
});

describe("assertRuleSet", () => {
  it("refuses a table whose first band does not start at zero", () => {
    expect(() =>
      assertRuleSet({ ...base, tiers: [{ from: 10_000, rateBps: 1_000 }] }),
    ).toThrow(/start at 0/);
  });

  it("refuses bands that are not strictly ascending", () => {
    // Equal bounds make the payout depend on which band the walk picks first.
    expect(() =>
      assertRuleSet({
        ...base,
        tiers: [
          { from: 0, rateBps: 500 },
          { from: 0, rateBps: 1_000 },
        ],
      }),
    ).toThrow(/ascending/);
  });

  it("refuses a zero or negative quota, which would divide attainment by zero", () => {
    expect(() => assertRuleSet({ ...base, quotaMinor: 0 })).toThrow(/quota/);
  });
});

describe("periodWindow", () => {
  it.each([
    ["MONTH" as const, "2026-02-14", "2026-02-01", "2026-02-28"],
    ["QUARTER" as const, "2026-02-14", "2026-01-01", "2026-03-31"],
    ["QUARTER" as const, "2026-11-30", "2026-10-01", "2026-12-31"],
    ["YEAR" as const, "2026-07-04", "2026-01-01", "2026-12-31"],
  ])("bounds %s containing %s", (period, on, start, end) => {
    expect(periodWindow(period, on)).toEqual({ start, end });
  });

  it("knows February's length in a leap year", () => {
    expect(periodWindow("MONTH", "2024-02-10").end).toBe("2024-02-29");
  });

  /**
   * The timezone trap. `new Date("2026-01-01")` is 2025-12-31 in any negative
   * UTC offset, so a date parsed through the local clock files the year's first
   * deal against the PREVIOUS year's quota — and only for deployments west of
   * Greenwich, which is how it survives a review.
   */
  it("does not shift the first day of a year into the previous one", () => {
    expect(periodWindow("YEAR", "2026-01-01")).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
    expect(periodWindow("MONTH", "2026-01-01").start).toBe("2026-01-01");
  });

  it("refuses something that is not an ISO date rather than guessing", () => {
    expect(() => periodWindow("MONTH", "14/02/2026")).toThrow(/ISO date/);
  });
});
