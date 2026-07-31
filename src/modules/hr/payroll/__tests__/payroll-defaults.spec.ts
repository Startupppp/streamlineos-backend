import {
  resolvePayrollDefaults,
  countWorkingDays,
  SEEDED_PAYROLL_DEFAULTS,
} from "../../lib/payroll-defaults";

describe("resolvePayrollDefaults", () => {
  it("returns seeded defaults when no policy config exists", () => {
    const result = resolvePayrollDefaults(null);
    expect(result.professionalTaxMonthly).toBe(200);
    expect(result.standardWorkingDaysPerMonth).toBe(22);
    expect(result.workWeekDays).toEqual([1, 2, 3, 4, 5]);
    expect(result.lopBasis).toBe("calendar");
    expect(result.defaultBasicPercent).toBe(50);
    expect(result.defaultHraPercent).toBe(50);
    expect(result.defaultAllowancePercent).toBe(25);
  });

  it("preserves seeded defaults when config is an empty object", () => {
    const result = resolvePayrollDefaults({});
    expect(result).toEqual(SEEDED_PAYROLL_DEFAULTS);
  });

  it("overrides professionalTaxMonthly from statutory config", () => {
    const config = { statutory: { professionalTaxMonthly: "300" } };
    const result = resolvePayrollDefaults(config);
    expect(result.professionalTaxMonthly).toBe(300);
  });

  it("ignores non-numeric professionalTaxMonthly", () => {
    const config = { statutory: { professionalTaxMonthly: "bad" } };
    const result = resolvePayrollDefaults(config);
    expect(result.professionalTaxMonthly).toBe(200);
  });

  it("overrides workWeekDays from orgConfig", () => {
    const config = { orgConfig: { workWeekDays: [0, 1, 2, 3, 4, 5, 6] } };
    const result = resolvePayrollDefaults(config);
    expect(result.workWeekDays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("overrides lopBasis from orgConfig", () => {
    const config = { orgConfig: { lopBasis: "working" } };
    const result = resolvePayrollDefaults(config);
    expect(result.lopBasis).toBe("working");
  });

  it("rejects invalid lopBasis values", () => {
    const config = { orgConfig: { lopBasis: "daily" } };
    const result = resolvePayrollDefaults(config);
    expect(result.lopBasis).toBe("calendar");
  });

  it("overrides salary split percentages from statutory config", () => {
    const config = { statutory: { defaultBasicPercent: "40", defaultHraPercent: "40", defaultAllowancePercent: "20" } };
    const result = resolvePayrollDefaults(config);
    expect(result.defaultBasicPercent).toBe(40);
    expect(result.defaultHraPercent).toBe(40);
    expect(result.defaultAllowancePercent).toBe(20);
  });

  it("overrides standardWorkingDaysPerMonth from orgConfig", () => {
    const config = { orgConfig: { standardWorkingDaysPerMonth: 26 } };
    const result = resolvePayrollDefaults(config);
    expect(result.standardWorkingDaysPerMonth).toBe(26);
  });
});

describe("countWorkingDays", () => {
  it("counts Mon–Fri working days for July 2025 correctly", () => {
    const count = countWorkingDays(2025, 7, [1, 2, 3, 4, 5]);
    expect(count).toBe(23);
  });

  it("returns 0 for empty work week", () => {
    const count = countWorkingDays(2025, 7, []);
    expect(count).toBe(0);
  });

  it("counts all 7 days when work week includes all", () => {
    const count = countWorkingDays(2025, 1, [0, 1, 2, 3, 4, 5, 6]);
    expect(count).toBe(31);
  });

  it("counts only Saturdays for a 4-Saturday month", () => {
    const count = countWorkingDays(2025, 2, [6]);
    expect(count).toBe(4);
  });

  it("produces standard 22-ish count for Mon–Fri in a typical month", () => {
    const count = countWorkingDays(2025, 4, [1, 2, 3, 4, 5]);
    expect(count).toBe(22);
  });

  it("seeded Mon–Fri matches the historical 22-day fallback expectation", () => {
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) =>
      countWorkingDays(2025, m, SEEDED_PAYROLL_DEFAULTS.workWeekDays),
    );
    const allReasonable = counts.every((c) => c >= 20 && c <= 23);
    expect(allReasonable).toBe(true);
  });
});
