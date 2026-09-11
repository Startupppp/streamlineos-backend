import {
  buildTotalRewardsStatement,
  estimateEmployerMonthlyBenefit,
} from "../total-rewards";

describe("total rewards", () => {
  it("estimates employer monthly benefit from premium + pct", () => {
    // ₹1,000 premium, 50% employer → ₹500
    expect(estimateEmployerMonthlyBenefit(100_000, 50)).toBe(500);
    expect(estimateEmployerMonthlyBenefit(null, 50)).toBeNull();
  });

  it("builds illustrative statement with cash + benefits + equity units", () => {
    const stmt = buildTotalRewardsStatement({
      asOf: new Date("2026-07-15"),
      cash: {
        annualCtc: 1_200_000,
        ytdGross: 400_000,
        ytdNet: 320_000,
        activeLoanBalance: 10_000,
      },
      benefits: [
        {
          planName: "Group Medical",
          category: "health",
          premiumCents: 200_000,
          employerContributionPct: 100,
          status: "active",
        },
      ],
      equity: [
        {
          grantType: "esop",
          units: 1000,
          strikePriceCents: 1000,
          status: "active",
          grantDate: "2025-04-01",
        },
      ],
      leave: [{ leaveType: "Earned Leave", balance: 12 }],
    });

    expect(stmt.mode).toBe("illustrative_statement");
    expect(stmt.honestyNote.toLowerCase()).toMatch(/illustrative|not a legally/);
    expect(stmt.financialYear).toBe("2026-27");
    expect(stmt.cash.annualCtc).toBe("1200000.00");
    expect(stmt.benefits.estimatedEmployerAnnual).toBe("24000.00"); // 2000*12
    expect(stmt.equity.totalUnits).toBe(1000);
    expect(stmt.equity.valued).toBe(false);
    expect(stmt.summary.completeness).toBe("rich");
  });

  it("accumulates employer annual benefit in exact integer paise across multiple plans", () => {
    const benefits = Array.from({ length: 10 }, (_, i) => ({
      planName: `Plan ${i}`,
      category: "health",
      premiumCents: 30,
      employerContributionPct: 100,
      status: "active",
    }));
    const stmt = buildTotalRewardsStatement({
      asOf: new Date("2026-07-01"),
      cash: { annualCtc: null, ytdGross: 0, ytdNet: 0, activeLoanBalance: 0 },
      benefits,
      equity: [],
      leave: [],
    });
    expect(stmt.benefits.estimatedEmployerAnnual).toBe("36.00");
    expect(10 * 30 * 12).toBe(3600);
    expect(parseFloat("0.30") * 12 === 3.6).toBe(false);
  });

  it("marks partial when salary profile missing", () => {
    const stmt = buildTotalRewardsStatement({
      cash: {
        annualCtc: null,
        ytdGross: 0,
        ytdNet: 0,
        activeLoanBalance: 0,
      },
      benefits: [],
      equity: [],
      leave: [],
    });
    expect(stmt.summary.completeness).toBe("partial");
    expect(stmt.summary.missing).toContain("active_salary_profile");
  });
});
