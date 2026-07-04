import { detectExceptions } from "../exception-engine";
import type { CalculationSnapshot } from "../../../payroll.types";
import { DEFAULT_PAYROLL_TOGGLES } from "../../../payroll.types";

const baseSnapshot: CalculationSnapshot = {
  policyVersionId: 1,
  computedAt: "2025-07-01T00:00:00.000Z",
  currency: "INR",
  fxRate: null,
  netPayoutCurrency: null,
  scheduledDays: "30",
  paidDays: "28",
  lopDays: "2",
  overtimeHours: "0",
  lines: [],
  totals: { gross: "80000.00", deductions: "10000.00", employerContributions: "10000.00", net: "70000.00" },
  variance: null,
};

describe("exception engine", () => {
  it("detects MISSING_SALARY_PROFILE", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: false, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
    });
    expect(results.some(e => e.code === "MISSING_SALARY_PROFILE")).toBe(true);
  });

  it("detects NEGATIVE_NET_PAY", () => {
    const snap = { ...baseSnapshot, totals: { ...baseSnapshot.totals, net: "-1000.00" } };
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: snap,
      toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
    });
    expect(results.some(e => e.code === "NEGATIVE_NET_PAY")).toBe(true);
  });

  it("detects LOP_EXCEEDS_SCHEDULED_DAYS", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 35,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
    });
    expect(results.some(e => e.code === "LOP_EXCEEDS_SCHEDULED_DAYS")).toBe(true);
  });

  it("no exceptions for clean employee", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
    });
    const blockers = results.filter(e => e.severity === "BLOCKER");
    expect(blockers).toHaveLength(0);
  });

  it("detects HIGH_VARIANCE", () => {
    const snap = {
      ...baseSnapshot,
      variance: { previousRunId: 0, previousNet: "70000.00", netDelta: "21000.00", netDeltaPercent: 30, changedComponents: [] },
    };
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: snap,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, payrollVarianceWarnings: true },
      scheduledDays: 30, lopDays: 2, varianceThresholdPercent: 20,
      hasAttendanceInput: true, hasApprovedTaxDeclaration: true,
      isJoiningInMonth: false, isExitInMonth: false, missingFxRate: false,
    });
    expect(results.some(e => e.code === "HIGH_VARIANCE")).toBe(true);
  });
});
