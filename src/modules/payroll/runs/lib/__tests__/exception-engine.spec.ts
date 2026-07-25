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

  it("detects MISSING_LOCKED_INPUT_PERIOD when freeze-before-pay is required", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, requireLockedPayrollInputs: true },
      scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
      missingLockedInputPeriod: true,
    });
    expect(results.some(e => e.code === "MISSING_LOCKED_INPUT_PERIOD")).toBe(true);
    expect(results.find(e => e.code === "MISSING_LOCKED_INPUT_PERIOD")?.severity).toBe("BLOCKER");
  });

  it("detects INPUT_NOT_FROM_LOCKED_SNAPSHOT when freeze required but live pull used", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, requireLockedPayrollInputs: true },
      scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
      missingLockedInputPeriod: false,
      inputNotFromLockedSnapshot: true,
    });
    expect(results.some(e => e.code === "INPUT_NOT_FROM_LOCKED_SNAPSHOT")).toBe(true);
  });

  it("detects MISSING_PF_UAN when PF enabled and UAN absent", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: true },
      scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
      missingPfUan: true,
    });
    expect(results.some(e => e.code === "MISSING_PF_UAN")).toBe(true);
    expect(results.find(e => e.code === "MISSING_PF_UAN")?.severity).toBe("WARNING");
  });

  it("detects MISSING_ESI_IP when ESI enabled and IP absent", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, esi: true },
      scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
      missingEsiIp: true,
    });
    expect(results.some(e => e.code === "MISSING_ESI_IP")).toBe(true);
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

  it("detects SALARY_ON_HOLD when isSalaryOnHold is true", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false, isSalaryOnHold: true,
    });
    expect(results.some(e => e.code === "SALARY_ON_HOLD")).toBe(true);
    expect(results.find(e => e.code === "SALARY_ON_HOLD")?.severity).toBe("WARNING");
  });

  it("does not detect SALARY_ON_HOLD when isSalaryOnHold is false or absent", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
    });
    expect(results.some(e => e.code === "SALARY_ON_HOLD")).toBe(false);
  });

  it("detects DUPLICATE_BANK_ACCOUNT when userId is in duplicateBankAccountUserIds", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false, duplicateBankAccountUserIds: ["u1", "u2"],
    });
    expect(results.some(e => e.code === "DUPLICATE_BANK_ACCOUNT")).toBe(true);
    expect(results.find(e => e.code === "DUPLICATE_BANK_ACCOUNT")?.severity).toBe("WARNING");
  });

  it("does not detect DUPLICATE_BANK_ACCOUNT when userId is not in the list", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false, duplicateBankAccountUserIds: ["u2", "u3"],
    });
    expect(results.some(e => e.code === "DUPLICATE_BANK_ACCOUNT")).toBe(false);
  });

  it("does not detect DUPLICATE_BANK_ACCOUNT when duplicateBankAccountUserIds is absent", () => {
    const results = detectExceptions({
      orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
      hasProfile: true, hasBankAccount: true, snapshot: baseSnapshot,
      toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 2,
      varianceThresholdPercent: 20, hasAttendanceInput: true,
      hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
      missingFxRate: false,
    });
    expect(results.some(e => e.code === "DUPLICATE_BANK_ACCOUNT")).toBe(false);
  });
});

describe("minimum wage (Labour Code wage definition)", () => {
  const baseInput = {
    orgId: "org1", runId: 1, runEmployeeId: 1, userId: "u1",
    hasProfile: true, hasBankAccount: true,
    toggles: DEFAULT_PAYROLL_TOGGLES, scheduledDays: 30, lopDays: 2,
    varianceThresholdPercent: 20, hasAttendanceInput: true,
    hasApprovedTaxDeclaration: true, isJoiningInMonth: false, isExitInMonth: false,
    missingFxRate: false,
  };

  it("raises BELOW_MINIMUM_WAGE when the statutory engine flags the wage split", () => {
    const snap: CalculationSnapshot = {
      ...baseSnapshot,
      wageDefinitionWarning:
        "Labour Code wage definition: Basic+DA is 30.0% of gross (minimum 50%).",
    };
    const results = detectExceptions({ ...baseInput, snapshot: snap });
    const found = results.find(e => e.code === "BELOW_MINIMUM_WAGE");
    expect(found).toBeDefined();
    expect(found?.message).toContain("30.0%");
  });

  it("is a WARNING, never a blocker — underpaying is worse than a bad structure", () => {
    const snap: CalculationSnapshot = {
      ...baseSnapshot,
      wageDefinitionWarning: "Labour Code wage definition: Basic+DA is 40.0% of gross (minimum 50%).",
    };
    const results = detectExceptions({ ...baseInput, snapshot: snap });
    expect(results.find(e => e.code === "BELOW_MINIMUM_WAGE")?.severity).toBe("WARNING");
    expect(results.filter(e => e.severity === "BLOCKER")).toHaveLength(0);
  });

  it("stays silent when the wage split is compliant", () => {
    const results = detectExceptions({ ...baseInput, snapshot: baseSnapshot });
    expect(results.some(e => e.code === "BELOW_MINIMUM_WAGE")).toBe(false);
  });

  it("stays silent for snapshots written before the field existed", () => {
    const legacy: CalculationSnapshot = { ...baseSnapshot, wageDefinitionWarning: undefined };
    const results = detectExceptions({ ...baseInput, snapshot: legacy });
    expect(results.some(e => e.code === "BELOW_MINIMUM_WAGE")).toBe(false);
  });
});
