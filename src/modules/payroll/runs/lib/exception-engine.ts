import type {
  PayrollExceptionCode,
  PayrollExceptionSeverity,
  PayrollToggles,
  CalculationSnapshot,
} from "../../payroll.types";
import { PAYROLL_EXCEPTION_CODES } from "../../payroll.types";
import { toPaise } from "./money";

export interface ExceptionInput {
  orgId: string;
  runId: number;
  runEmployeeId: number;
  userId: string;
  hasProfile: boolean;
  hasBankAccount: boolean;
  snapshot: CalculationSnapshot;
  toggles: PayrollToggles;
  scheduledDays: number;
  lopDays: number;
  varianceThresholdPercent: number;
  hasAttendanceInput: boolean;
  hasApprovedTaxDeclaration: boolean;
  isJoiningInMonth: boolean;
  isExitInMonth: boolean;
  missingFxRate: boolean;
  isSalaryOnHold?: boolean;
  duplicateBankAccountUserIds?: string[];
  /** Org requires freeze-before-pay and no locked hr_payroll_input period exists for the month. */
  missingLockedInputPeriod?: boolean;
  /** Attendance inputs were pulled live instead of from a locked snapshot. */
  inputNotFromLockedSnapshot?: boolean;
  /** PF contribution applies and UAN is missing on employee statutory details. */
  missingPfUan?: boolean;
  /** ESI contribution applies and ESI IP number is missing. */
  missingEsiIp?: boolean;
}

export interface DetectedExceptions {
  code: PayrollExceptionCode;
  severity: PayrollExceptionSeverity;
  message: string;
  metadata: Record<string, unknown> | null;
}

function makeException(
  code: PayrollExceptionCode,
  message: string,
  metadata: Record<string, unknown> | null = null,
): DetectedExceptions {
  return { code, severity: PAYROLL_EXCEPTION_CODES[code], message, metadata };
}

export function detectExceptions(input: ExceptionInput): DetectedExceptions[] {
  const {
    hasProfile, hasBankAccount, snapshot, toggles, scheduledDays, lopDays,
    varianceThresholdPercent, hasAttendanceInput, hasApprovedTaxDeclaration,
    isJoiningInMonth, isExitInMonth, missingFxRate,
  } = input;

  const results: DetectedExceptions[] = [];

  if (!hasProfile) {
    results.push(makeException("MISSING_SALARY_PROFILE", "Employee has no active salary profile for this period."));
  }

  if (!hasBankAccount) {
    results.push(makeException("MISSING_BANK_ACCOUNT", "Employee has no bank account on file. Cannot disburse salary."));
  }

  if (input.isSalaryOnHold) {
    results.push(makeException("SALARY_ON_HOLD", "Employee salary is on hold for this period. Disbursement will be skipped."));
  }

  if (input.duplicateBankAccountUserIds?.includes(input.userId)) {
    results.push(makeException(
      "DUPLICATE_BANK_ACCOUNT",
      "This employee shares a bank account with another employee in this run.",
      { userId: input.userId },
    ));
  }

  const netPaise = toPaise(snapshot.totals.net);

  if (netPaise < 0) {
    results.push(makeException(
      "NEGATIVE_NET_PAY",
      `Net pay is negative: ₹${snapshot.totals.net}. Review deductions.`,
      { net: snapshot.totals.net },
    ));
  } else if (netPaise === 0 && hasProfile) {
    results.push(makeException(
      "ZERO_NET_PAY",
      "Net pay is zero. Verify attendance and deductions.",
      { net: snapshot.totals.net },
    ));
  }

  if (toggles.lopFromAttendance && !hasAttendanceInput) {
    results.push(makeException(
      "MISSING_ATTENDANCE_INPUT",
      "Attendance data has not been imported for this employee. LOP cannot be computed.",
    ));
  }

  if (toggles.requireLockedPayrollInputs && input.missingLockedInputPeriod) {
    results.push(makeException(
      "MISSING_LOCKED_INPUT_PERIOD",
      "Payroll requires a locked input period for this month before generate/pay. Build and lock attendance/leave inputs first.",
    ));
  }

  if (
    toggles.requireLockedPayrollInputs &&
    !input.missingLockedInputPeriod &&
    input.inputNotFromLockedSnapshot
  ) {
    results.push(makeException(
      "INPUT_NOT_FROM_LOCKED_SNAPSHOT",
      "Employee attendance/LOP was not taken from the locked payroll-input snapshot. Review freeze completeness.",
    ));
  }

  if (toggles.pf && input.missingPfUan) {
    results.push(makeException(
      "MISSING_PF_UAN",
      "PF is enabled but employee has no UAN (12-digit) on statutory/bank details. ECR export will omit UAN.",
    ));
  }

  if (toggles.esi && input.missingEsiIp) {
    results.push(makeException(
      "MISSING_ESI_IP",
      "ESI is enabled but employee has no ESI IP number on statutory/bank details. ESI export will omit IP number.",
    ));
  }

  if (lopDays > scheduledDays) {
    results.push(makeException(
      "LOP_EXCEEDS_SCHEDULED_DAYS",
      `LOP days (${lopDays}) exceed scheduled days (${scheduledDays}).`,
      { lopDays, scheduledDays },
    ));
  }

  const hasFormulaError = snapshot.lines.some(
    l => l.explain.steps.some(s => s.startsWith("Error:")),
  );
  if (hasFormulaError) {
    results.push(makeException(
      "FORMULA_ERROR",
      "One or more salary components failed to evaluate due to a formula error.",
    ));
  }

  if (
    toggles.payrollVarianceWarnings &&
    snapshot.variance != null &&
    snapshot.variance.netDeltaPercent != null &&
    Math.abs(snapshot.variance.netDeltaPercent) >= varianceThresholdPercent
  ) {
    results.push(makeException(
      "HIGH_VARIANCE",
      `Net pay changed by ${snapshot.variance.netDeltaPercent.toFixed(1)}% vs previous run (threshold: ${varianceThresholdPercent}%).`,
      {
        netDelta: snapshot.variance.netDelta,
        netDeltaPercent: snapshot.variance.netDeltaPercent,
        threshold: varianceThresholdPercent,
      },
    ));
  }

  if (missingFxRate) {
    results.push(makeException(
      "MISSING_FX_RATE",
      "Employee is paid in a foreign currency but no FX rate is configured for this period.",
    ));
  }

  // Warning, not a blocker: the salary structure needs fixing, but withholding
  // pay the employee is already owed would be the worse outcome.
  if (snapshot.wageDefinitionWarning) {
    results.push(makeException(
      "BELOW_MINIMUM_WAGE",
      snapshot.wageDefinitionWarning,
      { basicDaShareOfGross: "below statutory minimum" },
    ));
  }

  if (toggles.employeeDeclarations && !hasApprovedTaxDeclaration) {
    results.push(makeException(
      "PENDING_TAX_DECLARATION",
      "Employee has not submitted or approved a tax declaration for this period.",
    ));
  }

  if (isJoiningInMonth) {
    results.push(makeException(
      "MID_PERIOD_JOINER",
      "Employee joined mid-period. Verify prorated salary computation.",
    ));
  }

  if (isExitInMonth) {
    results.push(makeException(
      "MID_PERIOD_EXIT",
      "Employee exited mid-period. Verify the final settlement and prorated salary.",
    ));
  }

  return results;
}
