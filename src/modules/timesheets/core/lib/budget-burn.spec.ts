import { computeBurn } from "./budget-burn";

const thresholds = [50, 80, 100];

describe("computeBurn", () => {
  it("computes hours-budget usage and remaining", () => {
    const r = computeBurn(
      { budgetType: "HOURS", budgetHours: 100, budgetAmount: null, alertThresholds: thresholds },
      42,
      9999,
    );
    expect(r.budget).toBe(100);
    expect(r.consumed).toBe(42);
    expect(r.percentUsed).toBe(42);
    expect(r.remaining).toBe(58);
    expect(r.alertLevel).toBe(0);
    expect(r.over).toBe(false);
  });

  it("computes amount-budget usage and ignores hours", () => {
    const r = computeBurn(
      { budgetType: "AMOUNT", budgetHours: null, budgetAmount: 10000, alertThresholds: thresholds },
      500,
      8500,
    );
    expect(r.consumed).toBe(8500);
    expect(r.percentUsed).toBe(85);
    expect(r.alertLevel).toBe(80);
    expect(r.over).toBe(false);
  });

  it("flags over-budget and the 100 threshold", () => {
    const r = computeBurn(
      { budgetType: "HOURS", budgetHours: 40, budgetAmount: null, alertThresholds: thresholds },
      48,
      0,
    );
    expect(r.percentUsed).toBe(120);
    expect(r.remaining).toBe(-8);
    expect(r.alertLevel).toBe(100);
    expect(r.over).toBe(true);
  });

  it("returns 0% when the budget is zero/unset", () => {
    const r = computeBurn(
      { budgetType: "HOURS", budgetHours: null, budgetAmount: null, alertThresholds: thresholds },
      10,
      10,
    );
    expect(r.percentUsed).toBe(0);
    expect(r.over).toBe(false);
  });
});
