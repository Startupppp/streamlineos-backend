import { Injectable, Inject } from "@nestjs/common";
import { and, eq, inArray, isNull, gte, lte, or } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollInputs,
  employeeSalaryProfileComponents,
  salaryComponents,
  bonuses,
  reimbursements,
  salaryLoans,
  payrollLoanAdjustments,
  incentives,
  taxDeclarations,
  organizationMembers,
} from "../../../db/schema";
import type { PayrollToggles } from "../payroll.types";
import type { CalcInputPulls } from "./lib/calculation-engine";
import {
  buildPulledInputsFromSections,
  loadLiveAttendanceByUser,
  loadLockedSectionsByUser,
  type PulledInputs,
  type SectionMap,
} from "./lib/input-puller";
import type { ResolvedComponent } from "./lib/calculation-engine";
import type { ProfileData, RunBatchData } from "./run-types";
import {
  getFyString,
  groupBy,
  type BonusRow,
  type IncentiveRow,
  type ReimbursementRow,
  type TaxDeclarationRow,
} from "./run-batch-loader.helpers";

type RunInputRow = typeof payrollInputs.$inferSelect;

// A run is materialized for a bounded employee snapshot. These caps keep a
// malformed or unexpectedly large input set from turning a calculation into
// an unbounded read; the caller already supplies the run's employee IDs.
const MAX_RUN_INPUT_ROWS = 10_000;
const MAX_COMPONENT_ROWS = 100_000;

@Injectable()
export class RunBatchLoaderService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async loadRunBatchData(
    orgId: string,
    runId: number,
    month: string,
    toggles: PayrollToggles,
    profiles: ProfileData[],
    lockedPeriodId: number | null,
  ): Promise<RunBatchData> {
    const userIds = profiles
      .map((p) => p.userId)
      .filter((id): id is string => id !== null);
    const membershipRows = userIds.length > 0
      ? await this.db
          .select({ membershipId: organizationMembers.id })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)))
          .limit(MAX_RUN_INPUT_ROWS)
      : [];
    const membershipIds = membershipRows.map((row) => row.membershipId);
    const profileIds = profiles.map((p) => p.id);
    const [year, mon] = month.split("-").map(Number);
    const monthStart = new Date(year, mon - 1, 1);
    const monthEnd = new Date(year, mon, 0, 23, 59, 59, 999);
    const fy = getFyString(month);

    const [
      lockedSectionsByUser,
      runInputRows,
      components,
      bonusRows,
      incentiveRows,
      reimbursementRows,
      loanRows,
      taxDeclRows,
    ] = await Promise.all([
      lockedPeriodId != null
        ? loadLockedSectionsByUser(this.db, orgId, lockedPeriodId, userIds)
        : Promise.resolve(new Map<string, SectionMap>()),
      userIds.length > 0
        ? this.db
            .select()
            .from(payrollInputs)
            .where(and(eq(payrollInputs.runId, runId), inArray(payrollInputs.userId, userIds)))
            .limit(MAX_RUN_INPUT_ROWS)
        : Promise.resolve([]),
      profileIds.length > 0
        ? this.loadComponentsByProfile(orgId, profileIds)
        : Promise.resolve(new Map<number, ResolvedComponent[]>()),
      toggles.bonuses && membershipIds.length > 0
        ? this.db
            .select({
              id: bonuses.id,
              userId: bonuses.userId,
              amount: bonuses.amount,
              type: bonuses.type,
              taxable: bonuses.taxable,
            })
            .from(bonuses)
            .where(and(eq(bonuses.orgId, orgId), inArray(bonuses.userMembershipId, membershipIds), eq(bonuses.status, "APPROVED"), eq(bonuses.month, month)))
            .limit(MAX_RUN_INPUT_ROWS)
        : Promise.resolve([]),
      toggles.incentives && userIds.length > 0
        ? this.db
            .select({
              id: incentives.id,
              salesRepId: incentives.salesRepId,
              approvedAmount: incentives.approvedAmount,
              calculatedAmount: incentives.calculatedAmount,
            })
            .from(incentives)
            .where(
              and(
                eq(incentives.orgId, orgId),
                inArray(incentives.salesRepId, userIds),
                eq(incentives.status, "APPROVED"),
                gte(incentives.approvedAt, monthStart),
                lte(incentives.approvedAt, monthEnd),
              ),
            )
            .limit(MAX_RUN_INPUT_ROWS)
        : Promise.resolve([]),
      toggles.reimbursements && membershipIds.length > 0
        ? this.db
            .select({ id: reimbursements.id, userId: reimbursements.userId, amount: reimbursements.amount, category: reimbursements.category })
            .from(reimbursements)
            .where(
              and(
                eq(reimbursements.orgId, orgId),
                inArray(reimbursements.userMembershipId, membershipIds),
                eq(reimbursements.status, "APPROVED"),
                isNull(reimbursements.paidAt),
                or(
                  isNull(reimbursements.payrollMonth),
                  eq(reimbursements.payrollMonth, month),
                ),
              ),
            )
            .limit(MAX_RUN_INPUT_ROWS)
        : Promise.resolve([]),
      toggles.loans && membershipIds.length > 0
        ? this.db
            .select()
            .from(salaryLoans)
            .where(and(eq(salaryLoans.orgId, orgId), inArray(salaryLoans.userMembershipId, membershipIds), eq(salaryLoans.status, "ACTIVE")))
            .limit(MAX_RUN_INPUT_ROWS)
        : Promise.resolve([]),
      toggles.tds && userIds.length > 0
        ? this.db
            .select({
              userId: taxDeclarations.userId,
              section80c: taxDeclarations.section80c,
              section80d: taxDeclarations.section80d,
              hra: taxDeclarations.hra,
              lta: taxDeclarations.lta,
              homeLoanInterest: taxDeclarations.homeLoanInterest,
              section80g: taxDeclarations.section80g,
              previousEmploymentIncome: taxDeclarations.previousEmploymentIncome,
              previousEmployerTds: taxDeclarations.previousEmployerTds,
              status: taxDeclarations.status,
            })
            .from(taxDeclarations)
            .where(
              and(
                eq(taxDeclarations.orgId, orgId),
                inArray(taxDeclarations.userId, userIds),
                eq(taxDeclarations.financialYear, fy),
                eq(taxDeclarations.status, "VERIFIED"),
              ),
            )
            .limit(MAX_RUN_INPUT_ROWS)
        : Promise.resolve([]),
    ]);

    const loanIds = loanRows.map((l) => l.id);
    const adjustments = loanIds.length > 0
      ? await this.db
          .select()
          .from(payrollLoanAdjustments)
          .where(and(eq(payrollLoanAdjustments.runId, runId), inArray(payrollLoanAdjustments.loanId, loanIds)))
          .limit(MAX_RUN_INPUT_ROWS)
      : [];

    const loansByUser = new Map<string, CalcInputPulls["activeLoans"]>();
    for (const [userId, userLoans] of groupBy(loanRows, (l) => l.userId)) {
      loansByUser.set(
        userId,
        userLoans.map((loan) => {
          const adj = adjustments.find((a) => a.loanId === loan.id);
          return {
            id: loan.id,
            emiAmount: loan.emiAmount,
            amount: loan.amount,
            paidEmis: loan.paidEmis,
            totalEmis: loan.totalEmis,
            adjustment: adj ? { type: adj.type, amount: adj.amount } : null,
          };
        }),
      );
    }

    const runInputsByUser = new Map<string, RunInputRow>();
    for (const row of runInputRows) {
      if (!runInputsByUser.has(row.userId)) runInputsByUser.set(row.userId, row);
    }

    const taxDeclarationByUser = new Map<string, TaxDeclarationRow>();
    for (const row of taxDeclRows) {
      if (!taxDeclarationByUser.has(row.userId)) taxDeclarationByUser.set(row.userId, row);
    }

    let liveAttendanceByUser = new Map<string, PulledInputs | null>();
    if (toggles.lopFromAttendance) {
      const usersNeedingLive = userIds.filter((userId) => {
        if (runInputsByUser.has(userId)) return false;
        const sections = lockedSectionsByUser.get(userId);
        return buildPulledInputsFromSections(userId, month, sections) == null;
      });
      liveAttendanceByUser = await loadLiveAttendanceByUser(this.db, orgId, usersNeedingLive, month);
    }

    return {
      lockedPeriodId,
      lockedSectionsByUser,
      runInputsByUser,
      liveAttendanceByUser,
      componentsByProfileId: components,
      bonusesByUser: groupBy(bonusRows, (b) => b.userId),
      incentivesByUser: groupBy(incentiveRows, (i) => i.salesRepId),
      reimbursementsByUser: groupBy(reimbursementRows, (r) => r.userId),
      loansByUser,
      taxDeclarationByUser,
    };
  }

  private async loadComponentsByProfile(orgId: string, profileIds: number[]): Promise<Map<number, ResolvedComponent[]>> {
    const rows = await this.db
      .select({
        profileId: employeeSalaryProfileComponents.profileId,
        id: salaryComponents.id,
        code: salaryComponents.code,
        name: salaryComponents.name,
        type: salaryComponents.type,
        calcMethod: salaryComponents.calcMethod,
        amount: employeeSalaryProfileComponents.amount,
        baseAmount: salaryComponents.amount,
        percent: employeeSalaryProfileComponents.percent,
        basePercent: salaryComponents.percent,
        formula: salaryComponents.formula,
        formulaOverride: employeeSalaryProfileComponents.formulaOverride,
        calcMethodOverride: employeeSalaryProfileComponents.calcMethodOverride,
        taxable: salaryComponents.taxable,
        showOnPayslip: salaryComponents.showOnPayslip,
        includeInCtc: salaryComponents.includeInCtc,
        isStatutory: salaryComponents.isStatutory,
        sortOrder: salaryComponents.sortOrder,
      })
      .from(employeeSalaryProfileComponents)
      .innerJoin(salaryComponents, eq(salaryComponents.id, employeeSalaryProfileComponents.componentId))
      .where(and(inArray(employeeSalaryProfileComponents.profileId, profileIds), eq(employeeSalaryProfileComponents.orgId, orgId)))
      .orderBy(salaryComponents.sortOrder)
      .limit(MAX_COMPONENT_ROWS);

    const byProfile = new Map<number, ResolvedComponent[]>();
    for (const r of rows) {
      const list = byProfile.get(r.profileId) ?? [];
      list.push({
        id: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        calcMethod: r.calcMethodOverride ?? r.calcMethod,
        amount: r.amount ?? r.baseAmount,
        percent: r.percent ?? r.basePercent,
        formula: r.formulaOverride ?? r.formula,
        taxable: r.taxable,
        showOnPayslip: r.showOnPayslip,
        includeInCtc: r.includeInCtc,
        isStatutory: r.isStatutory,
        sortOrder: r.sortOrder,
      });
      byProfile.set(r.profileId, list);
    }
    return byProfile;
  }
}
