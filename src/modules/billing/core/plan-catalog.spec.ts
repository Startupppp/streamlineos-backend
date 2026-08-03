import {
  PLAN_LIMITS,
  PLAN_PRICES_PAISE,
  PLAN_LOCKED_MODULES,
  ANNUAL_DISCOUNT_PCT,
  DEFAULT_TRIAL_DAYS,
  TRIAL_PLAN,
  buildPlanCatalog,
  monthlyPriceInr,
  annualMonthlyPriceInr,
  annualTotalPaise,
  getTrialDays,
  FREE_PLAN_MARKETING,
} from "./plan-entitlements.constants";

describe("plan catalog single source of truth", () => {
  it("builds catalog prices from PLAN_PRICES_PAISE", () => {
    const catalog = buildPlanCatalog();
    expect(catalog).toHaveLength(3);

    const starter = catalog.find((p) => p.id === "STARTER")!;
    expect(starter.monthlyPrice).toBe(monthlyPriceInr("STARTER"));
    expect(starter.monthlyPricePaise).toBe(PLAN_PRICES_PAISE.STARTER);
    expect(starter.annualPrice).toBe(annualMonthlyPriceInr("STARTER"));
    expect(starter.maxEmployees).toBe(PLAN_LIMITS.members.STARTER);
    expect(starter.features.length).toBeGreaterThan(0);
  });

  it("keeps seat limits consistent across catalog entries", () => {
    const catalog = buildPlanCatalog();
    for (const plan of catalog) {
      expect(plan.maxEmployees).toBe(PLAN_LIMITS.members[plan.id]);
    }
  });

  it("applies the documented annual discount to charged amounts", () => {
    const monthly = PLAN_PRICES_PAISE.PROFESSIONAL;
    const expected = Math.round(monthly * 12 * (1 - ANNUAL_DISCOUNT_PCT));
    expect(annualTotalPaise("PROFESSIONAL")).toBe(expected);
    expect(ANNUAL_DISCOUNT_PCT).toBe(0.2);
  });

  it("defaults trial to STARTER for DEFAULT_TRIAL_DAYS", () => {
    expect(TRIAL_PLAN).toBe("STARTER");
    expect(DEFAULT_TRIAL_DAYS).toBe(14);
    delete process.env.TRIAL_DAYS;
    expect(getTrialDays()).toBe(DEFAULT_TRIAL_DAYS);
  });

  it("honors TRIAL_DAYS env override within bounds", () => {
    process.env.TRIAL_DAYS = "21";
    expect(getTrialDays()).toBe(21);
    process.env.TRIAL_DAYS = "0";
    expect(getTrialDays()).toBe(DEFAULT_TRIAL_DAYS);
    process.env.TRIAL_DAYS = "999";
    expect(getTrialDays()).toBe(DEFAULT_TRIAL_DAYS);
    delete process.env.TRIAL_DAYS;
  });

  it("exposes free marketing seat limit from PLAN_LIMITS", () => {
    expect(FREE_PLAN_MARKETING.seatLimit).toBe(PLAN_LIMITS.members.FREE);
    expect(FREE_PLAN_MARKETING.monthlyPrice).toBe(0);
  });

  it("locks payroll and inventory on FREE only", () => {
    expect(PLAN_LOCKED_MODULES.FREE).toEqual(
      expect.arrayContaining(["payroll", "inventory"]),
    );
    expect(PLAN_LOCKED_MODULES.PAID).toEqual([]);
    expect(PLAN_LOCKED_MODULES.ENTERPRISE).toEqual([]);
  });
});
