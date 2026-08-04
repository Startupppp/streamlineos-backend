import { and, eq, count, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import {
  payrollInputs,
  payrollExceptions,
  payrollBankBatches,
  payrollTaxWindows,
  payrollRunEmployees,
  payrollLineItems,
  reimbursements,
  bonuses,
  salaryLoans,
} from "../../../../db/schema";
import { hrPayrollInputPeriods } from "../../../../db/schema/hr/payroll-inputs";
import type { PayrollChecklistItem, PayrollToggles } from "../../payroll.types";
import { requirePayrollUserIds } from "../../lib/payroll-user-id";
import type { payrollRuns } from "../../../../db/schema";

/**
 * Pure freeze-before-pay checklist item.
 * When requireLockedPayrollInputs is on, period must be locked for generate/pay readiness.
 */
export function buildInputsLockedChecklistItem(
  requireLockedInputs: boolean,
  inputsLocked: boolean,
): PayrollChecklistItem {
  return {
    key: "inputs_locked",
    label: "Payroll inputs locked (freeze before pay)",
    done: !requireLockedInputs || inputsLocked,
    href: "/payroll/inputs",
    detail: requireLockedInputs
      ? inputsLocked
        ? "Period inputs are locked and immutable for this month"
        : "Build and lock attendance/leave inputs before generate/pay"
      : "Optional — enable Require Locked Inputs on payroll policy",
  };
}

export async function buildRunChecklist(
  db: Db,
  orgId: string,
  run: typeof payrollRuns.$inferSelect,
  toggles: PayrollToggles | null,
): Promise<PayrollChecklistItem[]> {
  const runId = run.id;
  const month = run.month;
  const [yearStr, monthStr] = month.split("-");
  const runYear = parseInt(yearStr, 10);
  const runMonth = parseInt(monthStr, 10);
  const fyStartYear = runMonth >= 4 ? runYear : runYear - 1;
  const financialYear = `${fyStartYear}-${fyStartYear + 1}`;

  const [
    missingProfileExceptions,
    inputsCount,
    pendingReimbursements,
    pendingBonuses,
    taxWindow,
    openExceptions,
    bankBatch,
    lockedInputPeriod,
  ] = await Promise.all([
    db
      .select({ total: count() })
      .from(payrollExceptions)
      .where(
        and(
          eq(payrollExceptions.runId, runId),
          eq(payrollExceptions.code, "MISSING_SALARY_PROFILE"),
          eq(payrollExceptions.status, "OPEN"),
        ),
      ),
    db
      .select({ total: count() })
      .from(payrollInputs)
      .where(and(eq(payrollInputs.runId, runId), eq(payrollInputs.orgId, orgId))),
    db
      .select({ total: count() })
      .from(reimbursements)
      .where(and(eq(reimbursements.orgId, orgId), eq(reimbursements.status, "PENDING"))),
    db
      .select({ total: count() })
      .from(bonuses)
      .where(
        and(
          eq(bonuses.orgId, orgId),
          eq(bonuses.status, "PENDING"),
          sql`${bonuses.month} = ${month}`,
        ),
      ),
    db
      .select({ status: payrollTaxWindows.status })
      .from(payrollTaxWindows)
      .where(
        and(
          eq(payrollTaxWindows.orgId, orgId),
          eq(payrollTaxWindows.financialYear, financialYear),
        ),
      )
      .limit(1),
    db
      .select({ total: count() })
      .from(payrollExceptions)
      .where(
        and(
          eq(payrollExceptions.runId, runId),
          eq(payrollExceptions.status, "OPEN"),
          eq(payrollExceptions.severity, "BLOCKER"),
        ),
      ),
    db
      .select({ id: payrollBankBatches.id })
      .from(payrollBankBatches)
      .where(and(eq(payrollBankBatches.runId, runId), eq(payrollBankBatches.orgId, orgId)))
      .limit(1),
    db
      .select({ id: hrPayrollInputPeriods.id, status: hrPayrollInputPeriods.status })
      .from(hrPayrollInputPeriods)
      .where(
        and(
          eq(hrPayrollInputPeriods.orgId, orgId),
          eq(hrPayrollInputPeriods.periodKey, month),
          eq(hrPayrollInputPeriods.status, "locked"),
        ),
      )
      .limit(1),
  ]);

  const runStatus = run.status;
  const isDraftOrPreparing = runStatus === "PREPARING" || runStatus === "DRAFT";
  const isApproved = ["APPROVED", "LOCKED", "PAID", "PAYSLIPS_PUBLISHED", "CLOSED"].includes(runStatus);
  const isPublished = ["PAYSLIPS_PUBLISHED", "CLOSED"].includes(runStatus);

  const lopEnabled = toggles?.lopFromAttendance ?? false;
  const requireLockedInputs = toggles?.requireLockedPayrollInputs ?? false;
  const loansEnabled = toggles?.loans ?? false;
  const hasInputs = (inputsCount[0]?.total ?? 0) > 0;
  const hasMissingProfile = (missingProfileExceptions[0]?.total ?? 0) > 0;
  const hasPendingReimbursements = (pendingReimbursements[0]?.total ?? 0) > 0;
  const hasPendingBonuses = (pendingBonuses[0]?.total ?? 0) > 0;
  const taxLocked = taxWindow[0]?.status === "LOCKED";
  const hasOpenBlockers = (openExceptions[0]?.total ?? 0) > 0;
  const hasBankBatch = (bankBatch[0]?.id ?? null) !== null;
  const inputsLocked = (lockedInputPeriod[0]?.id ?? null) !== null;

  let loansApplied = true;
  let loansDetail: string | null = null;

  if (!loansEnabled) {
    loansDetail = "Loans disabled";
  } else {
    const empUserIds = await db
      .select({ userId: payrollRunEmployees.userId })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    const userIds = requirePayrollUserIds(empUserIds.map((r) => r.userId));

    if (userIds.length > 0) {
      const activeLoans = await db
        .select({ id: salaryLoans.id, totalEmis: salaryLoans.totalEmis, paidEmis: salaryLoans.paidEmis })
        .from(salaryLoans)
        .where(
          and(
            eq(salaryLoans.orgId, orgId),
            eq(salaryLoans.status, "ACTIVE"),
            inArray(salaryLoans.userId, userIds),
          ),
        );

      const loansWithRemainingEmis = activeLoans.filter(
        l => (l.totalEmis ?? 0) - (l.paidEmis ?? 0) > 0,
      );

      if (loansWithRemainingEmis.length === 0) {
        loansApplied = true;
      } else if (isDraftOrPreparing) {
        loansApplied = false;
        loansDetail = "Run not yet generated — loan EMI deductions pending";
      } else {
        const loanCodes = loansWithRemainingEmis.map(l => `LOAN_EMI_${l.id}`);
        const foundLines = await db
          .select({ code: payrollLineItems.code })
          .from(payrollLineItems)
          .where(
            and(
              eq(payrollLineItems.runId, runId),
              eq(payrollLineItems.orgId, orgId),
              inArray(payrollLineItems.code, loanCodes),
            ),
          );
        const foundCodes = new Set(foundLines.map(l => l.code));
        const missing = loanCodes.filter(c => !foundCodes.has(c));
        loansApplied = missing.length === 0;
        if (!loansApplied) {
          loansDetail = `${missing.length} loan(s) not yet deducted in this run`;
        }
      }
    }
  }

  const items: PayrollChecklistItem[] = [
    {
      key: "employees_verified",
      label: "Employees verified",
      done: !hasMissingProfile,
      href: `/payroll/runs/${runId}/exceptions`,
      detail: hasMissingProfile ? "Some employees have missing salary profiles" : null,
    },
    {
      key: "attendance_imported",
      label: "Attendance imported",
      done: !lopEnabled || hasInputs || inputsLocked,
      href: `/payroll/runs/${runId}/inputs`,
      detail:
        lopEnabled && !hasInputs && !inputsLocked
          ? "LOP from attendance is enabled but no inputs imported"
          : null,
    },
    buildInputsLockedChecklistItem(requireLockedInputs, inputsLocked),
    {
      key: "reimbursements_approved",
      label: "Reimbursements approved",
      done: !hasPendingReimbursements,
      href: `/payroll/reimbursements`,
      detail: hasPendingReimbursements ? "Some reimbursements are pending approval" : null,
    },
    {
      key: "variable_pay_approved",
      label: "Variable pay approved",
      done: !hasPendingBonuses,
      href: `/payroll/bonuses`,
      detail: hasPendingBonuses ? "Some bonuses are pending approval" : null,
    },
    {
      key: "loans_applied",
      label: "Loans applied",
      done: loansApplied,
      href: loansApplied ? null : `/payroll/runs/${runId}`,
      detail: loansDetail,
    },
    {
      key: "tax_declarations_locked",
      label: "Tax declarations locked",
      done: taxLocked,
      href: `/payroll/tax-windows`,
      detail: !taxLocked ? "Tax window is not locked for the current financial year" : null,
    },
    {
      key: "preview_generated",
      label: "Preview generated",
      done: !isDraftOrPreparing,
      href: `/payroll/runs/${runId}`,
      detail: isDraftOrPreparing ? "Run preview has not been generated yet" : null,
    },
    {
      key: "exceptions_resolved",
      label: "Exceptions resolved",
      done: !hasOpenBlockers,
      href: `/payroll/runs/${runId}/exceptions`,
      detail: hasOpenBlockers ? "Open blocker exceptions need resolution" : null,
    },
    {
      key: "payroll_approved",
      label: "Payroll approved",
      done: isApproved,
      href: `/payroll/runs/${runId}`,
      detail: !isApproved ? "Payroll is pending approval" : null,
    },
    {
      key: "bank_file_generated",
      label: "Bank file generated",
      done: hasBankBatch,
      href: `/payroll/runs/${runId}/payout`,
      detail: !hasBankBatch ? "Bank payment file has not been generated" : null,
    },
    {
      key: "payslips_published",
      label: "Payslips published",
      done: isPublished,
      href: `/payroll/runs/${runId}`,
      detail: !isPublished ? "Payslips have not been published to employees" : null,
    },
  ];

  return items;
}
