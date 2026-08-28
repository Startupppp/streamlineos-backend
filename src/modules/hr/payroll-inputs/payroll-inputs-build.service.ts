import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { primaryEmploymentOfPerson, livePersonOfEmployment } from "../../directory/employment-query";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrPayrollInputSnapshots,
  hrPayrollInputPeriods,
} from "../../../db/schema/payroll/input-capture";
import {
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
import { AttendanceSummaryService } from "../time/attendance-summary.service";
import { LeaveLedgerService } from "../time/leave-ledger.service";
import { HrBenefitsClaimsService } from "../benefits/hr-benefits-claims.service";

function periodBounds(periodKey: string): { start: string; end: string } {
  const [year, month] = periodKey.split("-");
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  return {
    start: `${periodKey}-01`,
    end: `${periodKey}-${String(lastDay).padStart(2, "0")}`,
  };
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
    const { start, end } = periodBounds(period.periodKey);

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
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)));

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
    ] = await Promise.all([
      this.attendanceSummary.buildAttendanceSummary({
        orgId,
        periodStart: start,
        periodEnd: end,
        userIds,
      }),
      this.leaveLedger.buildLeaveSummary(orgId, start, end),
      this.db
        .select()
        .from(overtimeRequests)
        .where(
          and(
            eq(overtimeRequests.orgId, orgId),
            eq(overtimeRequests.status, "APPROVED"),
            inArray(overtimeRequests.userId, userIds),
            gte(overtimeRequests.date, start),
            lte(overtimeRequests.date, end),
          ),
        ),
      this.db
        .select()
        .from(reimbursements)
        .where(
          and(
            eq(reimbursements.orgId, orgId),
            eq(reimbursements.status, "APPROVED"),
            inArray(reimbursements.userId, userIds),
            gte(reimbursements.createdAt, new Date(start)),
            lte(reimbursements.createdAt, new Date(end + "T23:59:59Z")),
          ),
        ),
      this.db
        .select()
        .from(salaryLoans)
        .where(
          and(
            eq(salaryLoans.orgId, orgId),
            eq(salaryLoans.status, "ACTIVE"),
            inArray(salaryLoans.userId, userIds),
          ),
        ),
      this.db
        .select()
        .from(employeeSalaryProfiles)
        .where(
          and(
            eq(employeeSalaryProfiles.orgId, orgId),
            eq(employeeSalaryProfiles.status, "ACTIVE"),
            inArray(employeeSalaryProfiles.userId, userIds),
            lte(employeeSalaryProfiles.effectiveFrom, end),
          ),
        ),
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
        .catch(() => []),
      this.benefitsClaims.getPayrollPayableClaims(orgId, periodStart, periodEnd),
      this.benefitsClaims.getDueLoanRepayments(orgId, periodStart, periodEnd),
    ]);

    const attendanceByUser = new Map(attendanceResult.data.map((r) => [r.userId, r]));
    const leaveByUser = new Map(leaveResult.map((r) => [r.userId, r]));

    const overtimeByUser = new Map<string, (typeof overtimeRequests.$inferSelect)[]>();
    for (const row of overtimeRows) {
      const existing = overtimeByUser.get(row.userId) ?? [];
      existing.push(row);
      overtimeByUser.set(row.userId, existing);
    }

    const reimbByUser = new Map<string, (typeof reimbursements.$inferSelect)[]>();
    for (const row of reimbursementRows) {
      const existing = reimbByUser.get(row.userId) ?? [];
      existing.push(row);
      reimbByUser.set(row.userId, existing);
    }

    const loansByUser = new Map<string, (typeof salaryLoans.$inferSelect)[]>();
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

    const salaryProfileByUser = new Map<string, typeof employeeSalaryProfiles.$inferSelect>();
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

      const reimbursementPayload = {
        userId,
        items: [
          ...reimbs.map((r) => ({
            id: r.id,
            category: r.category,
            amount: r.amount,
            description: r.description,
            payrollMonth: r.payrollMonth,
            approvedAt: r.approvedAt,
            source: "reimbursement" as const,
          })),
          ...benefitClaims.map((c) => ({
            id: c.id,
            category: "benefits_claim" as const,
            amount: String(c.amountCents),
            description: `Insurance claim #${c.claimNumber}`,
            payrollMonth: null,
            approvedAt: c.decidedAt,
            source: "benefits_claim" as const,
          })),
        ],
        totalAmount:
          reimbs.reduce((sum, r) => sum + parseFloat(r.amount ?? "0"), 0) +
          benefitClaims.reduce((sum, c) => sum + c.amountCents, 0),
      };

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
        payload: payload as Record<string, unknown>,
        sourceRefs: (sourceRefs ?? null) as Record<string, unknown> | null,
      });

      snapshotValues.push(
        buildSnapshot("employee_master", employeeMasterPayload),
        buildSnapshot("compensation", compensationPayload, salaryProfile ? [{ table: "employee_salary_profiles", id: salaryProfile.id }] : null),
        buildSnapshot("attendance", attendancePayload),
        buildSnapshot("leave", leavePayload),
        buildSnapshot("overtime", overtimePayload, otRows.map((r) => ({ table: "overtime_requests", id: r.id }))),
        buildSnapshot("reimbursement", reimbursementPayload, [
          ...reimbs.map((r) => ({ table: "reimbursements", id: r.id })),
          ...benefitClaims.map((c) => ({ table: "hr_insurance_claims", id: c.id })),
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
