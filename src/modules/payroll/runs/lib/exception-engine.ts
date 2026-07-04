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
      "Employee exited mid-period. Verify FnF and prorated salary.",
    ));
  }

  return results;
}
