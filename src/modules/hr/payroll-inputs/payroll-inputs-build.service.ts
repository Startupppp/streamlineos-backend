import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { primaryEmploymentOfPerson, livePersonOfEmployment } from "../../directory/employment-query";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrPayrollInputSnapshots,
  hrPayrollInputPeriods,
} from "../../../db/schema/payroll/input-capture";
import {
  expenses,
  leaveRequests,
  reimbursements,
  salaryLoans,
} from "../../../db/schema";
import {
  hrEmployments,
  hrPeople,
} from "../../../db/schema/hr/core-people";

import { employeeSalaryProfiles } from "../../../db/schema/payroll/workforce";
import { overtimeRequests } from "../../../db/schema/hr/overtime";
import { organizationMembers, users } from "../../../db/schema/common/auth";
import { buildReimbursementPayload } from "./payroll-inputs-money";
import { payableExpenseClaims } from "../../payroll/runs/lib/payable-expenses";
import { groupBy } from "../../payroll/runs/run-batch-loader.helpers";
import { periodBoundsFrom } from "./payroll-period-key";
import { AttendanceSummaryService } from "../time/attendance-summary.service";
import { LeaveLedgerService } from "../time/leave-ledger.service";
import { HrBenefitsClaimsService } from "../benefits/hr-benefits-claims.service";

/**
 * Row ceiling for every scan that feeds a payroll-input period.
 *
 * These reads are NOT paged. Each is issued with `limit(CAP + 1)` so a full page
 * is distinguishable from a truncated one, and `assertNotTruncated` turns an
 * overflow into a loud failure. Silently keeping the first CAP rows would write
 * a period that *looks* complete while some employees have no compensation,
 * attendance, leave or reimbursement input at all — and with no ORDER BY, which
 * ones were dropped would vary between runs of the same period. A period like
 * that gets reviewed and locked, and payroll runs off it.
 */
const PAYROLL_INPUT_SCAN_CAP = 1000;

function assertNotTruncated(rows: { length: number }, source: string, periodKey: string): void {
  if (rows.length > PAYROLL_INPUT_SCAN_CAP) {
    throw new Error(
      `Payroll input build for period ${periodKey} exceeded the ${PAYROLL_INPUT_SCAN_CAP}-row ceiling on ${source}. ` +
        `Refusing to write a partial period; this scan must be paged before an organisation this size can be built.`,
    );
  }
}

@Injectable()
export class PayrollInputsBuildService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly attendanceSummary: AttendanceSummaryService,
    private readonly leaveLedger: LeaveLedgerService,
    private readonly benefitsClaims: HrBenefitsClaimsService,
  ) {}

  async buildSnapshots(orgId: string, period: typeof hrPayrollInputPeriods.$inferSelect): Promise<void> {
    const { start, end } = periodBoundsFrom(period.periodKey);

    const members = await this.db
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
      // Deterministic order: without it the rows kept under the ceiling are
      // whatever Postgres happened to return, so the same period could cover a
      // different set of employees on each run.
      .orderBy(organizationMembers.userId)
      .limit(PAYROLL_INPUT_SCAN_CAP + 1);

    assertNotTruncated(members, "active organisation members", period.periodKey);

    if (members.length === 0) return;

    const userIds = members.map((m) => m.userId);

    const periodStart = new Date(start);
    const periodEnd = new Date(end + "T23:59:59Z");

    const [
      attendanceResult,
      leaveResult,
      overtimeRows,
      reimbursementRows,
      loanRows,
      salaryProfileRows,
      employmentRows,
      benefitsClaimsRows,
      loanRepaymentRows,
      expenseRows,
      lopLeaveRows,
    ] = await Promise.all([
      this.attendanceSummary.buildAttendanceSummary({
        orgId,
        periodStart: start,
        periodEnd: end,
        userIds,
      }),
      this.leaveLedger.buildLeaveSummary(orgId, start, end),
      this.db
        .select({
          id: overtimeRequests.id,
          userId: overtimeRequests.userId,
          date: overtimeRequests.date,
          hours: overtimeRequests.hours,
          convertToCompOff: overtimeRequests.convertToCompOff,
        })
        .from(overtimeRequests)
        .where(
          and(
            eq(overtimeRequests.orgId, orgId),
            eq(overtimeRequests.status, "APPROVED"),
            inArray(overtimeRequests.userId, userIds),
            gte(overtimeRequests.date, start),
            lte(overtimeRequests.date, end),
          ),
        )
        .limit(PAYROLL_INPUT_SCAN_CAP + 1),
      this.db
        .select({
          id: reimbursements.id,
          userId: reimbursements.userId,
          category: reimbursements.category,
          amount: reimbursements.amount,
          description: reimbursements.description,
          payrollMonth: reimbursements.payrollMonth,
          approvedAt: reimbursements.approvedAt,
        })
        .from(reimbursements)
        .where(
          and(
            eq(reimbursements.orgId, orgId),
            eq(reimbursements.status, "APPROVED"),
            inArray(reimbursements.userId, userIds),
            gte(reimbursements.createdAt, new Date(start)),
            lte(reimbursements.createdAt, new Date(end + "T23:59:59Z")),
          ),
        )
        .limit(PAYROLL_INPUT_SCAN_CAP + 1),
      this.db
        .select({
          id: salaryLoans.id,
          userId: salaryLoans.userId,
          amount: salaryLoans.amount,
          emiAmount: salaryLoans.emiAmount,
          totalEmis: salaryLoans.totalEmis,
          paidEmis: salaryLoans.paidEmis,
          reason: salaryLoans.reason,
        })
        .from(salaryLoans)
        .where(
          and(
            eq(salaryLoans.orgId, orgId),
            eq(salaryLoans.status, "ACTIVE"),
            inArray(salaryLoans.userId, userIds),
          ),
        )
        .limit(PAYROLL_INPUT_SCAN_CAP + 1),
      this.db
        .select({
          id: employeeSalaryProfiles.id,
          userId: employeeSalaryProfiles.userId,
          annualCtc: employeeSalaryProfiles.annualCtc,
          currency: employeeSalaryProfiles.currency,
          payFrequency: employeeSalaryProfiles.payFrequency,
          effectiveFrom: employeeSalaryProfiles.effectiveFrom,
          basicSalary: employeeSalaryProfiles.basicSalary,
          allowances: employeeSalaryProfiles.allowances,
        })
        .from(employeeSalaryProfiles)
        .where(
          and(
            eq(employeeSalaryProfiles.orgId, orgId),
            eq(employeeSalaryProfiles.status, "ACTIVE"),
            inArray(employeeSalaryProfiles.userId, userIds),
            lte(employeeSalaryProfiles.effectiveFrom, end),
          ),
        )
        .limit(PAYROLL_INPUT_SCAN_CAP + 1),
      this.db
        .select({
          id: hrEmployments.id,
          orgId: hrEmployments.orgId,
          personId: hrEmployments.personId,
          employeeNumber: hrEmployments.employeeNumber,
          lifecycleStatus: hrEmployments.lifecycleStatus,
          workerType: hrEmployments.workerType,
          designation: hrEmployments.designation,
          joiningDate: hrEmployments.joiningDate,
          probationEndDate: hrEmployments.probationEndDate,
          confirmationDate: hrEmployments.confirmationDate,
          lastWorkingDay: hrEmployments.lastWorkingDay,
          exitDate: hrEmployments.exitDate,
          resolvedUserId: hrPeople.userId,
        })
        .from(hrEmployments)
        .innerJoin(hrPeople, livePersonOfEmployment(orgId))
        .where(
          and(
            primaryEmploymentOfPerson(orgId),
            inArray(hrPeople.userId, userIds),
          ),
        )
        .limit(PAYROLL_INPUT_SCAN_CAP + 1)
        .catch(() => []),
      this.benefitsClaims.getPayrollPayableClaims(orgId, periodStart, periodEnd),
      this.benefitsClaims.getDueLoanRepayments(orgId, periodStart, periodEnd),
      this.db
        .select({
          id: expenses.id,
          userId: expenses.userId,
          category: expenses.category,
          amount: expenses.amount,
          currency: expenses.currency,
          description: expenses.description,
          approvedAt: expenses.approvedAt,
          expenseDate: expenses.expenseDate,
        })
        .from(expenses)
        .where(payableExpenseClaims(orgId, userIds, end))
        .orderBy(expenses.id)
        .limit(PAYROLL_INPUT_SCAN_CAP + 1),
      this.db
        .select({
          id: leaveRequests.id,
          userId: leaveRequests.userId,
          startDate: leaveRequests.startDate,
          endDate: leaveRequests.endDate,
          lopDays: leaveRequests.lopDays,
        })
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.orgId, orgId),
            eq(leaveRequests.status, "APPROVED"),
            inArray(leaveRequests.userId, userIds),
            gt(leaveRequests.lopDays, "0"),
            gte(leaveRequests.startDate, start),
            lte(leaveRequests.endDate, end),
          ),
        )
        .orderBy(leaveRequests.id)
        .limit(PAYROLL_INPUT_SCAN_CAP + 1),
    ]);

    // Each sibling scan carries the same ceiling as the member scan and is just
    // as capable of dropping rows silently — a truncated reimbursement or salary
    // profile read costs an employee real money in the run built off this period.
    assertNotTruncated(overtimeRows, "approved overtime requests", period.periodKey);
    assertNotTruncated(reimbursementRows, "approved reimbursements", period.periodKey);
    assertNotTruncated(loanRows, "active salary loans", period.periodKey);
    assertNotTruncated(salaryProfileRows, "active salary profiles", period.periodKey);
    assertNotTruncated(employmentRows, "primary employments", period.periodKey);
    assertNotTruncated(expenseRows, "approved expense claims", period.periodKey);
    assertNotTruncated(lopLeaveRows, "unpaid leave requests", period.periodKey);

    const attendanceByUser = new Map(attendanceResult.data.map((r) => [r.userId, r]));
    const leaveByUser = new Map(leaveResult.map((r) => [r.userId, r]));

    const overtimeByUser = new Map<string, (typeof overtimeRows)[number][]>();
    for (const row of overtimeRows) {
      const existing = overtimeByUser.get(row.userId) ?? [];
      existing.push(row);
      overtimeByUser.set(row.userId, existing);
    }

    const reimbByUser = new Map<string, (typeof reimbursementRows)[number][]>();
    for (const row of reimbursementRows) {
      const existing = reimbByUser.get(row.userId) ?? [];
      existing.push(row);
      reimbByUser.set(row.userId, existing);
    }

    const expensesByUser = groupBy(expenseRows, (r) => r.userId);
    const lopLeavesByUser = groupBy(lopLeaveRows, (r) => r.userId);

    const loansByUser = new Map<string, (typeof loanRows)[number][]>();
    for (const row of loanRows) {
      const existing = loansByUser.get(row.userId) ?? [];
      existing.push(row);
      loansByUser.set(row.userId, existing);
    }

    const loanIdToUserId = new Map<number, string>(loanRows.map((l) => [l.id, l.userId]));

    const benefitsClaimsByUser = new Map<string, (typeof benefitsClaimsRows)[number][]>();
    for (const row of benefitsClaimsRows) {
      const existing = benefitsClaimsByUser.get(row.userId) ?? [];
      existing.push(row);
      benefitsClaimsByUser.set(row.userId, existing);
    }

    const loanRepaymentsByUser = new Map<string, (typeof loanRepaymentRows)[number][]>();
    for (const row of loanRepaymentRows) {
      const userId = loanIdToUserId.get(row.loanId);
      if (!userId) continue;
      const existing = loanRepaymentsByUser.get(userId) ?? [];
      existing.push(row);
      loanRepaymentsByUser.set(userId, existing);
    }

    const salaryProfileByUser = new Map<string, (typeof salaryProfileRows)[number]>();
    for (const row of salaryProfileRows) {
      if (!row.userId) continue;
      const existing = salaryProfileByUser.get(row.userId);
      if (!existing || row.effectiveFrom > existing.effectiveFrom) {
        salaryProfileByUser.set(row.userId, row);
      }
    }

    type EmploymentRow = (typeof employmentRows)[number];

    const employmentByUser = new Map<string, EmploymentRow>();
    for (const row of employmentRows) {
      if (!row.resolvedUserId) continue;
      employmentByUser.set(row.resolvedUserId, row);
    }

    const snapshotValues: (typeof hrPayrollInputSnapshots.$inferInsert)[] = [];

    for (const member of members) {
      const { userId } = member;
      const displayName =
        member.name ||
        [member.firstName, member.lastName].filter(Boolean).join(" ") ||
        member.email;

      const attendance = attendanceByUser.get(userId);
      const leave = leaveByUser.get(userId);
      const otRows = overtimeByUser.get(userId) ?? [];
      const reimbs = reimbByUser.get(userId) ?? [];
      const expenseClaims = expensesByUser.get(userId) ?? [];
      const lopLeaves = lopLeavesByUser.get(userId) ?? [];
      const loans = loansByUser.get(userId) ?? [];
      const benefitClaims = benefitsClaimsByUser.get(userId) ?? [];
      const dueRepayments = loanRepaymentsByUser.get(userId) ?? [];
      const salaryProfile = salaryProfileByUser.get(userId);
      const employment = employmentByUser.get(userId);

      const employeeMasterPayload = {
        userId,
        displayName,
        email: member.email,
        workerType: employment?.workerType ?? null,
        designation: employment?.designation ?? null,
        joiningDate: employment?.joiningDate ?? null,
        lifecycleStatus: employment?.lifecycleStatus ?? "ACTIVE",
      };

      const compensationPayload = salaryProfile
        ? {
            profileId: salaryProfile.id,
            annualCtc: salaryProfile.annualCtc,
            currency: salaryProfile.currency,
            payFrequency: salaryProfile.payFrequency,
            effectiveFrom: salaryProfile.effectiveFrom,
            basicSalary: salaryProfile.basicSalary ?? null,
            allowances: salaryProfile.allowances ?? null,
          }
        : {
            profileId: null,
            annualCtc: null,
            currency: "INR",
            payFrequency: "MONTHLY",
            effectiveFrom: null,
            basicSalary: null,
            allowances: null,
          };

      const attendancePayload = attendance ?? {
        userId,
        payableDays: 0,
        presentDays: 0,
        absentDays: 0,
        lateCount: 0,
        latePenaltyDays: 0,
        earlyExitCount: 0,
        approvedRegularizations: 0,
        overtimeMinutes: 0,
        weekendWorkDays: 0,
        holidayWorkDays: 0,
      };

      const leavePayload = leave ?? {
        userId,
        paidLeaveDays: 0,
        unpaidLeaveDays: 0,
        halfDayCount: 0,
        hourlyLeaveHours: 0,
        compOffUsed: 0,
        encashmentDays: 0,
      };

      const overtimePayload = {
        userId,
        approvedRequests: otRows.map((r) => ({
          id: r.id,
          date: r.date,
          hours: r.hours,
          convertToCompOff: r.convertToCompOff,
        })),
        totalHours: otRows.reduce((sum, r) => sum + parseFloat(r.hours ?? "0"), 0),
      };

      const reimbursementPayload = buildReimbursementPayload(userId, reimbs, benefitClaims, expenseClaims);

      const deductionPayload = {
        userId,
        activeLoans: loans.map((l) => ({
          id: l.id,
          amount: l.amount,
          emiAmount: l.emiAmount,
          totalEmis: l.totalEmis,
          paidEmis: l.paidEmis,
          reason: l.reason,
        })),
        totalMonthlyEmi: loans.reduce((sum, l) => sum + parseFloat(l.emiAmount ?? "0"), 0),
        scheduledRepayments: dueRepayments.map((r) => ({
          id: r.id,
          loanId: r.loanId,
          installmentNo: r.installmentNo,
          dueDate: r.dueDate,
          amountCents: r.amountCents,
          source: "loan_repayment" as const,
        })),
        totalRepaymentCents: dueRepayments.reduce((sum, r) => sum + r.amountCents, 0),
      };

      const lifecyclePayload = {
        userId,
        joiningDate: employment?.joiningDate ?? null,
        probationEndDate: employment?.probationEndDate ?? null,
        confirmationDate: employment?.confirmationDate ?? null,
        lastWorkingDay: employment?.lastWorkingDay ?? null,
        exitDate: employment?.exitDate ?? null,
        lifecycleStatus: employment?.lifecycleStatus ?? "ACTIVE",
        workerType: employment?.workerType ?? null,
      };

      const buildSnapshot = (
        section: typeof hrPayrollInputSnapshots.$inferInsert["section"],
        payload: unknown,
        sourceRefs?: unknown,
      ): typeof hrPayrollInputSnapshots.$inferInsert => ({
        orgId,
        periodId: period.id,
        userId,
        section,
        payload,
        sourceRefs: sourceRefs ?? null,
      });

      snapshotValues.push(
        buildSnapshot("employee_master", employeeMasterPayload),
        buildSnapshot("compensation", compensationPayload, salaryProfile ? [{ table: "employee_salary_profiles", id: salaryProfile.id }] : null),
        buildSnapshot("attendance", attendancePayload),
        buildSnapshot("leave", leavePayload, lopLeaves.map((l) => (
          { table: "leave_requests", id: l.id, label: `Unpaid leave · ${Number(l.lopDays)}d`, date: l.startDate, endDate: l.endDate }
        ))),
        buildSnapshot("overtime", overtimePayload, otRows.map((r) => (
          { table: "overtime_requests", id: r.id, label: `Overtime · ${Number(r.hours)}h`, date: r.date }
        ))),
        buildSnapshot("reimbursement", reimbursementPayload, [
          ...reimbs.map((r) => ({ table: "reimbursements", id: r.id, label: `Reimbursement #${r.id} · ${r.category}` })),
          ...benefitClaims.map((c) => ({ table: "hr_insurance_claims", id: c.id, label: `Insurance claim #${c.claimNumber}` })),
          ...reimbursementPayload.items
            .filter((i) => i.source === "expense")
            .map((i) => ({ table: "expenses", id: i.id, label: `Expense claim #${i.id} · ${i.category}`, date: i.date ?? null })),
        ]),
        buildSnapshot("deduction", deductionPayload, [
          ...loans.map((l) => ({ table: "salary_loans", id: l.id })),
          ...dueRepayments.map((r) => ({ table: "hr_loan_repayments", id: r.id })),
        ]),
        buildSnapshot("lifecycle", lifecyclePayload, employment ? [{ table: "hr_employments", id: employment.id }] : null),
      );
    }

    await this.db.transaction(async (tx) => {
      await tx
        .delete(hrPayrollInputSnapshots)
        .where(and(eq(hrPayrollInputSnapshots.orgId, orgId), eq(hrPayrollInputSnapshots.periodId, period.id)));

      if (snapshotValues.length > 0) {
        await tx.insert(hrPayrollInputSnapshots).values(snapshotValues);
      }
    });
  }
}
