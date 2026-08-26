import { downgradeImpact, prorate } from "./proration";

const JANUARY = { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-31T00:00:00Z") };
const FEBRUARY = { start: new Date("2026-02-01T00:00:00Z"), end: new Date("2026-03-01T00:00:00Z") };

describe("upgrading mid-cycle", () => {
  it("charges for the days remaining, worked by hand", () => {
    // 30-day period, change on day 20, 10 days left.
    // Old ₹1,000.00 → credit 100000 × 10/30 = 33333
    // New ₹2,500.00 → charge 250000 × 10/30 = 83333
    // Net 50000, or ₹500.00
    const result = prorate({
      period: JANUARY,
      changeAt: new Date("2026-01-21T00:00:00Z"),
      oldPlanAmountMinor: 100_000,
      newPlanAmountMinor: 250_000,
    });

    expect(result.totalDays).toBe(30);
    expect(result.remainingDays).toBe(10);
    expect(result.creditMinor).toBe(33_333);
    expect(result.chargeMinor).toBe(83_333);
    expect(result.netMinor).toBe(50_000);
  });

  it("charges the full difference when the change is on the first day", () => {
    const result = prorate({
      period: JANUARY,
      changeAt: JANUARY.start,
      oldPlanAmountMinor: 100_000,
      newPlanAmountMinor: 250_000,
    });

    expect(result.remainingDays).toBe(30);
    expect(result.netMinor).toBe(150_000);
  });

  it("charges nothing when the change lands on the last day", () => {
    // No days remain to be charged for, so growing on the final day is free
    // rather than a full month.
    const result = prorate({
      period: JANUARY,
      changeAt: JANUARY.end,
      oldPlanAmountMinor: 100_000,
      newPlanAmountMinor: 250_000,
    });

    expect(result.remainingDays).toBe(0);
    expect(result.netMinor).toBe(0);
  });
});

describe("downgrading mid-cycle", () => {
  it("returns a negative net, meaning a credit is owed", () => {
    const result = prorate({
      period: JANUARY,
      changeAt: new Date("2026-01-16T00:00:00Z"),
      oldPlanAmountMinor: 250_000,
      newPlanAmountMinor: 100_000,
    });

    expect(result.netMinor).toBeLessThan(0);
    expect(result.netMinor).toBe(result.chargeMinor - result.creditMinor);
  });
});

describe("period boundaries", () => {
  it("handles a 28-day February without a special case", () => {
    const result = prorate({
      period: FEBRUARY,
      changeAt: new Date("2026-02-15T00:00:00Z"),
      oldPlanAmountMinor: 100_000,
      newPlanAmountMinor: 200_000,
    });

    expect(result.totalDays).toBe(28);
    expect(result.remainingDays).toBe(14);
    expect(result.netMinor).toBe(50_000);
  });

  it("handles a change on the last day of a month", () => {
    // The case the ticket names: 31 January, one day left in a 30-day period.
    const result = prorate({
      period: JANUARY,
      changeAt: new Date("2026-01-30T00:00:00Z"),
      oldPlanAmountMinor: 100_000,
      newPlanAmountMinor: 250_000,
    });

    expect(result.remainingDays).toBe(1);
    expect(result.netMinor).toBe(Math.round(250_000 / 30) - Math.round(100_000 / 30));
  });

  it("clamps a change dated before the period, rather than over-crediting", () => {
    // A change dated before the period starts would otherwise credit more than
    // was ever paid.
    const result = prorate({
      period: JANUARY,
      changeAt: new Date("2025-12-01T00:00:00Z"),
      oldPlanAmountMinor: 100_000,
      newPlanAmountMinor: 250_000,
    });

    expect(result.remainingDays).toBe(30);
    expect(result.creditMinor).toBe(100_000);
  });

  it("clamps a change dated after the period, rather than charging beyond it", () => {
    const result = prorate({
      period: JANUARY,
      changeAt: new Date("2026-06-01T00:00:00Z"),
      oldPlanAmountMinor: 100_000,
      newPlanAmountMinor: 250_000,
    });

    expect(result.remainingDays).toBe(0);
    expect(result.netMinor).toBe(0);
  });

  it("refuses a zero-day period rather than dividing by zero", () => {
    expect(() =>
      prorate({
        period: { start: JANUARY.start, end: JANUARY.start },
        changeAt: JANUARY.start,
        oldPlanAmountMinor: 100_000,
        newPlanAmountMinor: 250_000,
      }),
    ).toThrow(/at least one whole day/);
  });
});

describe("arithmetic a customer can check", () => {
  it("stays integer in minor units for every day of a period", () => {
    // A charge of 1234.5000000001 minor units is not a charge, it is an argument.
    for (let day = 1; day <= 30; day += 1) {
      const result = prorate({
        period: JANUARY,
        changeAt: new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00Z`),
        oldPlanAmountMinor: 99_900,
        newPlanAmountMinor: 249_900,
      });

      expect(Number.isInteger(result.creditMinor)).toBe(true);
      expect(Number.isInteger(result.chargeMinor)).toBe(true);
      expect(Number.isInteger(result.netMinor)).toBe(true);
    }
  });

  it("never credits more than the old plan cost", () => {
    for (let day = 1; day <= 30; day += 1) {
      const result = prorate({
        period: JANUARY,
        changeAt: new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00Z`),
        oldPlanAmountMinor: 100_000,
        newPlanAmountMinor: 250_000,
      });

      expect(result.creditMinor).toBeLessThanOrEqual(100_000);
      expect(result.chargeMinor).toBeLessThanOrEqual(250_000);
    }
  });

  it("rounds once per side, so the two agree with the net", () => {
    const result = prorate({
      period: JANUARY,
      changeAt: new Date("2026-01-08T00:00:00Z"),
      oldPlanAmountMinor: 99_900,
      newPlanAmountMinor: 249_900,
    });

    expect(result.netMinor).toBe(result.chargeMinor - result.creditMinor);
  });
});

describe("downgradeImpact", () => {
  it("names what would be exceeded, so a downgrade is not a surprise outage", () => {
    const impact = downgradeImpact({ members: 40, projects: 3 }, { members: 25, projects: 10 });

    expect(impact.isBlocking).toBe(true);
    expect(impact.exceeded).toEqual([{ key: "members", current: 40, newLimit: 25 }]);
  });

  it("allows a downgrade that fits", () => {
    const impact = downgradeImpact({ members: 10 }, { members: 25 });
    expect(impact.isBlocking).toBe(false);
  });

  it("treats a negative limit as unlimited rather than as zero", () => {
    // Reading -1 as zero would block every downgrade to an unlimited plan.
    expect(downgradeImpact({ members: 500 }, { members: -1 }).isBlocking).toBe(false);
  });

  it("treats a limit of exactly the current count as fitting", () => {
    expect(downgradeImpact({ members: 25 }, { members: 25 }).isBlocking).toBe(false);
  });

  it("treats an absent count as zero rather than as unknown", () => {
    expect(downgradeImpact({} as Record<"members", number>, { members: 5 }).isBlocking).toBe(false);
  });
});
