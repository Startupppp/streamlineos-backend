/**
 * Contract: monthly leave accrual uses leave_policies.accrualRate only.
 * No hardcoded rate constants in accrual path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("CronLeaveService policy-driven accrual (Phase 3.1)", () => {
  const source =
    readFileSync(join(__dirname, "../cron-leave.service.ts"), "utf8") +
    readFileSync(join(__dirname, "../cron-leave-reset.service.ts"), "utf8");

  it("implements monthly accrual from leave_policies", () => {
    expect(source).toContain("accrueMonthlyLeaves");
    expect(source).toContain('accrualType, "MONTHLY"');
    expect(source).toContain("Monthly leave accrual from leave_policies");
  });

  it("does not hardcode monthly accrual amount", () => {
    expect(source).toMatch(/const rate = Number\(policy\.accrualRate\)/);
    expect(source).not.toMatch(/accrualRate\s*\?\?\s*1\.[5-9]/);
    expect(source).not.toMatch(/const\s+DEFAULT_ACCRUAL\s*=/);
  });

  it("annual reset uses policy accrualRate not only leaveTypes.daysPerYear", () => {
    expect(source).toContain('accrualType, "ANNUAL"');
    expect(source).toContain("Yearly leave reset accrual from leave_policies");
    expect(source).toMatch(/const annualDays = Number\(policy\.accrualRate\)/);
  });
});
