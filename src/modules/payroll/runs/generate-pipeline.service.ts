import { Injectable, Inject } from "@nestjs/common";
import { and, eq, inArray, isNull, gte, lte, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollInputs,
  payrollRunEmployees,
  payrollLineItems,
  payrollExceptions,
  employeeSalaryProfileComponents,
  salaryComponents,
  bonuses,
  reimbursements,
  salaryLoans,
  payrollLoanAdjustments,
  incentives,
  taxDeclarations,
} from "../../../db/schema";
import type { PayrollPolicyConfig, PayrollToggles, CalculationSnapshot, InputsSnapshot } from "../payroll.types";
import { calcPayroll, type ResolvedComponent, type CalcInputPulls } from "./lib/calculation-engine";
import { detectExceptions, type ExceptionInput } from "./lib/exception-engine";
import {
  buildCalcPullsFromSections,
  buildPulledInputsFromSections,
  loadLiveAttendanceByUser,
  loadLockedSectionsByUser,
  type PulledInputs,
  type SectionMap,
} from "./lib/input-puller";
import { daysInMonth } from "./lib/money";
import { payrollSubjectKey, isWorkerOnlySubject } from "../lib/payroll-subject";

export interface ProfileData {
  id: number;
  userId: string | null;
  workerId: string | null;
  workerType: "EMPLOYEE" | "CONTRACTOR" | "CONSULTANT" | "INTERN" | "EOR";
  currency: string;
  payoutCurrency: string | null;
  annualCtc: string;
  taxRegime: "OLD" | "NEW" | null;
}

function getFyString(month: string): string {
  const [yearStr, monStr] = month.split("-");
  const year = parseInt(yearStr ?? "2025", 10);
  const mon = parseInt(monStr ?? "4", 10);
  if (mon >= 4) {
    return `${year}-${String(year + 1).slice(-2)}`;
  }
  return `${year - 1}-${String(year).slice(-2)}`;
}

type RunInputRow = typeof payrollInputs.$inferSelect;
type BonusRow = { id: number; userId: string; amount: string; type: string; taxable: boolean };
type IncentiveRow = { id: number; salesRepId: string; approvedAmount: string | null; calculatedAmount: string };
type ReimbursementRow = { id: number; userId: string; amount: string; category: string };
type TaxDeclarationRow = {
  userId: string;
  section80c: string;
  section80d: string;
  hra: string;
  lta: string;
  homeLoanInterest: string;
  section80g: string;
  previousEmploymentIncome: string;
  previousEmployerTds: string;
  status: string;
};

export interface RunBatchData {
  lockedPeriodId: number | null;
  lockedSectionsByUser: Map<string, SectionMap>;
  runInputsByUser: Map<string, RunInputRow>;
  liveAttendanceByUser: Map<string, PulledInputs | null>;
  componentsByProfileId: Map<number, ResolvedComponent[]>;
  bonusesByUser: Map<string, BonusRow[]>;
  incentivesByUser: Map<string, IncentiveRow[]>;
  reimbursementsByUser: Map<string, ReimbursementRow[]>;
  loansByUser: Map<string, CalcInputPulls["activeLoans"]>;
  taxDeclarationByUser: Map<string, TaxDeclarationRow>;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k) ?? [];
    list.push(row);
    map.set(k, list);
  }
  return map;
}

@Injectable()
export class GeneratePipelineService {
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
    const profileIds = profiles.map((p) => p.id);
    const [year, mon] = month.split("-").map(Number);
    const monthStart = new Date(year!, mon! - 1, 1);
    const monthEnd = new Date(year!, mon!, 0, 23, 59, 59, 999);
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
        : Promise.resolve([] as RunInputRow[]),
      profileIds.length > 0 ? this.loadComponentsByProfile(orgId, profileIds) : Promise.resolve(new Map<number, ResolvedComponent[]>()),
      toggles.bonuses && userIds.length > 0
        ? this.db
            .select({
              id: bonuses.id,
              userId: bonuses.userId,
              amount: bonuses.amount,
              type: bonuses.type,
              taxable: bonuses.taxable,
            })
            .from(bonuses)
            .where(and(eq(bonuses.orgId, orgId), inArray(bonuses.userId, userIds), eq(bonuses.status, "APPROVED"), eq(bonuses.month, month)))
        : Promise.resolve([] as BonusRow[]),
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
        : Promise.resolve([] as IncentiveRow[]),
      toggles.reimbursements && userIds.length > 0
        ? this.db
            .select({ id: reimbursements.id, userId: reimbursements.userId, amount: reimbursements.amount, category: reimbursements.category })
            .from(reimbursements)
            .where(
              and(
                eq(reimbursements.orgId, orgId),
                inArray(reimbursements.userId, userIds),
                eq(reimbursements.status, "APPROVED"),
                isNull(reimbursements.paidAt),
                or(
                  isNull(reimbursements.payrollMonth),
                  eq(reimbursements.payrollMonth, month),
                ),
              ),
            )
        : Promise.resolve([] as ReimbursementRow[]),
      toggles.loans && userIds.length > 0
        ? this.db
            .select()
            .from(salaryLoans)
            .where(and(eq(salaryLoans.orgId, orgId), inArray(salaryLoans.userId, userIds), eq(salaryLoans.status, "ACTIVE")))
        : Promise.resolve([] as (typeof salaryLoans.$inferSelect)[]),
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
        : Promise.resolve([] as TaxDeclarationRow[]),
    ]);

    const loanIds = loanRows.map((l) => l.id);
    const adjustments = loanIds.length > 0
      ? await this.db
          .select()
          .from(payrollLoanAdjustments)
          .where(and(eq(payrollLoanAdjustments.runId, runId), inArray(payrollLoanAdjustments.loanId, loanIds)))
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

  buildInputsFromBatch(userId: string, month: string, toggles: PayrollToggles, batch: RunBatchData): InputsSnapshot {
    const existing = batch.runInputsByUser.get(userId);
    if (existing) {
      return {
        source: existing.source,
        scheduledDays: existing.scheduledDays,
        paidDays: existing.paidDays,
        lopDays: existing.lopDays,
        halfDays: existing.halfDays,
        overtimeHours: existing.overtimeHours,
        shiftAllowanceUnits: existing.shiftAllowanceUnits,
        holidayWorkDays: existing.holidayWorkDays,
        billableHours: existing.billableHours,
        isOverride: existing.isOverride,
        overrideReason: existing.overrideReason,
      };
    }

    if (toggles.lopFromAttendance) {
      const pulled =
        buildPulledInputsFromSections(userId, month, batch.lockedSectionsByUser.get(userId)) ??
        batch.liveAttendanceByUser.get(userId) ??
        null;
      if (pulled) {
        return {
          source: pulled.source,
          scheduledDays: pulled.scheduledDays,
          paidDays: pulled.paidDays,
          lopDays: pulled.lopDays,
          halfDays: pulled.halfDays,
          overtimeHours: pulled.overtimeHours,
          shiftAllowanceUnits: pulled.shiftAllowanceUnits,
          holidayWorkDays: pulled.holidayWorkDays,
          billableHours: pulled.billableHours,
          isOverride: false,
          overrideReason: pulled.fromLockedSnapshot
            ? "Locked payroll input period snapshot"
            : null,
        };
      }
    }

    const totalDays = String(daysInMonth(month));
    return {
      source: "MANUAL",
      scheduledDays: totalDays,
      paidDays: totalDays,
      lopDays: "0",
      halfDays: "0",
      overtimeHours: "0",
      shiftAllowanceUnits: "0",
      holidayWorkDays: "0",
      billableHours: "0",
      isOverride: false,
      overrideReason: null,
    };
  }

  buildCalcInputsFromBatch(userId: string, toggles: PayrollToggles, batch: RunBatchData): CalcInputPulls {
    const locked = buildCalcPullsFromSections(batch.lockedSectionsByUser.get(userId));

    const approvedBonuses = toggles.bonuses ? (batch.bonusesByUser.get(userId) ?? []) : [];
    const rawIncentives = toggles.incentives ? (batch.incentivesByUser.get(userId) ?? []) : [];
    const approvedIncentives = rawIncentives.map((i) => ({
      amount: i.approvedAmount ?? i.calculatedAmount,
    }));

    let approvedReimbursements: { amount: string; category: string }[] = [];
    let consumedReimbursementIds: number[] = [];
    let activeLoans: CalcInputPulls["activeLoans"] = [];

    if (locked && toggles.reimbursements) {
      approvedReimbursements = locked.approvedReimbursements;
      consumedReimbursementIds = locked.consumedReimbursementIds;
    } else if (toggles.reimbursements) {
      const rawReimbursements = batch.reimbursementsByUser.get(userId) ?? [];
      approvedReimbursements = rawReimbursements.map((r) => ({ amount: r.amount, category: r.category }));
      consumedReimbursementIds = rawReimbursements.map((r) => r.id);
    }

    if (locked && toggles.loans) {
      activeLoans = locked.activeLoans;
    } else if (toggles.loans) {
      activeLoans = batch.loansByUser.get(userId) ?? [];
    }

    const decl = toggles.tds ? batch.taxDeclarationByUser.get(userId) : undefined;
    const taxDeclaration = decl
      ? {
          section80c: decl.section80c,
          section80d: decl.section80d,
          hra: decl.hra,
          lta: decl.lta,
          homeLoanInterest: decl.homeLoanInterest,
          section80g: decl.section80g,
          previousEmploymentIncome: decl.previousEmploymentIncome,
          previousEmployerTds: decl.previousEmployerTds,
        }
      : null;

    return {
      approvedBonuses: approvedBonuses.map((b) => ({ amount: b.amount, type: b.type, taxable: b.taxable })),
      approvedIncentives,
      approvedReimbursements,
      consumedReimbursementIds,
      consumedIncentiveIds: rawIncentives.map((i) => i.id),
      consumedBonusIds: approvedBonuses.map((b) => b.id),
      activeLoans,
      taxDeclaration,
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
      .orderBy(salaryComponents.sortOrder);

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

  runCalcAndDetect(
    profile: ProfileData,
    components: ResolvedComponent[],
    inputs: InputsSnapshot,
    pulls: CalcInputPulls,
    toggles: PayrollToggles,
    config: PayrollPolicyConfig,
    policyVersionId: number | null,
    month: string,
    previousSnapshot: CalculationSnapshot | null,
    hasAttendanceInput: boolean,
    exceptionFlags: {
      isSalaryOnHold: boolean;
      duplicateBankAccountUserIds: string[];
      missingLockedInputPeriod?: boolean;
      inputNotFromLockedSnapshot?: boolean;
      missingPfUan?: boolean;
      missingEsiIp?: boolean;
      lockedInputBaseline?: {
        paidDays: string;
        lopDays: string;
      } | null;
    },
  ): { snapshot: CalculationSnapshot; exceptions: ReturnType<typeof detectExceptions> } {
    let fxRate: string | null = null;
    let missingFxRate = false;

    if (profile.payoutCurrency != null && profile.payoutCurrency !== profile.currency) {
      const rate = config.fxRates?.[profile.payoutCurrency];
      if (rate != null) {
        fxRate = rate;
      } else {
        missingFxRate = true;
      }
    }

    const snapshot = calcPayroll({
      policyVersionId,
      month,
      annualCtcDecimal: profile.annualCtc,
      workerType: profile.workerType,
      currency: profile.currency,
      payoutCurrency: profile.payoutCurrency,
      fxRate,
      taxRegime: profile.taxRegime,
      components,
      toggles,
      config,
      inputs: {
        scheduledDays: inputs.scheduledDays,
        paidDays: inputs.paidDays,
        lopDays: inputs.lopDays,
        overtimeHours: inputs.overtimeHours,
        billableHours: inputs.billableHours,
      },
      pulls,
      previousSnapshot,
    });

    const hasApprovedTaxDeclaration = pulls.taxDeclaration != null;

    const lockedBaseline = exceptionFlags.lockedInputBaseline;
    if (lockedBaseline) {
      const paidDelta =
        parseFloat(inputs.paidDays) - parseFloat(lockedBaseline.paidDays);
      const lopDelta =
        parseFloat(inputs.lopDays) - parseFloat(lockedBaseline.lopDays);
      const inputBaseline = {
        lockedPaidDays: lockedBaseline.paidDays,
        lockedLopDays: lockedBaseline.lopDays,
        paidDaysDelta: Number.isFinite(paidDelta) ? paidDelta : null,
        lopDaysDelta: Number.isFinite(lopDelta) ? lopDelta : null,
      };
      if (snapshot.variance) {
        snapshot.variance = {
          ...snapshot.variance,
          baselineSource:
            snapshot.variance.baselineSource === "PREVIOUS_RUN"
              ? "PREVIOUS_RUN_AND_LOCKED_INPUTS"
              : "LOCKED_INPUT_SNAPSHOT",
          inputBaseline,
        };
      } else {
        snapshot.variance = {
          previousRunId: null,
          previousNet: null,
          netDelta: null,
          netDeltaPercent: null,
          changedComponents: [],
          baselineSource: "LOCKED_INPUT_SNAPSHOT",
          inputBaseline,
        };
      }
    }

    const exceptionInput: ExceptionInput = {
      orgId: "",
      runId: 0,
      runEmployeeId: 0,
      userId: profile.userId ?? payrollSubjectKey(profile),
      hasProfile: true,
      hasBankAccount: !isWorkerOnlySubject(profile),
      snapshot,
      toggles,
      scheduledDays: parseFloat(inputs.scheduledDays),
      lopDays: parseFloat(inputs.lopDays),
      varianceThresholdPercent: config.varianceThresholdPercent ?? 20,
      hasAttendanceInput,
      hasApprovedTaxDeclaration,
      isJoiningInMonth: false,
      isExitInMonth: false,
      missingFxRate,
      isSalaryOnHold: exceptionFlags.isSalaryOnHold,
      duplicateBankAccountUserIds: exceptionFlags.duplicateBankAccountUserIds,
      missingLockedInputPeriod: exceptionFlags.missingLockedInputPeriod,
      inputNotFromLockedSnapshot: exceptionFlags.inputNotFromLockedSnapshot,
      missingPfUan: exceptionFlags.missingPfUan,
      missingEsiIp: exceptionFlags.missingEsiIp,
    };

    const exceptions = detectExceptions(exceptionInput);
    return { snapshot, exceptions };
  }

  async upsertRunEmployee(
    db: Db,
    orgId: string,
    runId: number,
    profile: ProfileData,
    inputs: InputsSnapshot,
    snapshot: CalculationSnapshot,
    knownExistingId?: number | null,
  ): Promise<number> {
    const existing =
      knownExistingId === undefined
        ? await db
            .select({ id: payrollRunEmployees.id })
            .from(payrollRunEmployees)
            .where(
              and(
                eq(payrollRunEmployees.runId, runId),
                profile.userId
                  ? eq(payrollRunEmployees.userId, profile.userId)
                  : profile.workerId
                    ? eq(payrollRunEmployees.workerId, profile.workerId)
                    : sql`false`,
              ),
            )
            .limit(1)
        : knownExistingId === null
          ? []
          : [{ id: knownExistingId }];

    if (existing[0]) {
      await db
        .update(payrollRunEmployees)
        .set({
          profileId: profile.id,
          workerType: profile.workerType,
          currency: profile.currency,
          payoutCurrency: profile.payoutCurrency,
          fxRate: snapshot.fxRate ?? null,
          netPayoutCurrency: snapshot.netPayoutCurrency ?? null,
          scheduledDays: inputs.scheduledDays,
          paidDays: inputs.paidDays,
          lopDays: inputs.lopDays,
          overtimeHours: inputs.overtimeHours,
          gross: snapshot.totals.gross,
          totalDeductions: snapshot.totals.deductions,
          employerContributions: snapshot.totals.employerContributions,
          net: snapshot.totals.net,
          inputsSnapshot: inputs,
          calculationSnapshot: snapshot,
        })
        .where(eq(payrollRunEmployees.id, existing[0].id));

      return existing[0].id;
    }

    const inserted = await db
      .insert(payrollRunEmployees)
      .values({
        orgId,
        runId,
        userId: profile.userId,
        workerId: profile.workerId,
        profileId: profile.id,
        workerType: profile.workerType,
        currency: profile.currency,
        payoutCurrency: profile.payoutCurrency,
        fxRate: snapshot.fxRate ?? null,
        netPayoutCurrency: snapshot.netPayoutCurrency ?? null,
        scheduledDays: inputs.scheduledDays,
        paidDays: inputs.paidDays,
        lopDays: inputs.lopDays,
        overtimeHours: inputs.overtimeHours,
        gross: snapshot.totals.gross,
        totalDeductions: snapshot.totals.deductions,
        employerContributions: snapshot.totals.employerContributions,
        net: snapshot.totals.net,
        inputsSnapshot: inputs,
        calculationSnapshot: snapshot,
      })
      .returning({ id: payrollRunEmployees.id });

    return inserted[0]!.id;
  }

  async replaceLineItems(db: Db, orgId: string, runId: number, runEmployeeId: number, snapshot: CalculationSnapshot): Promise<void> {
    await db.delete(payrollLineItems).where(eq(payrollLineItems.runEmployeeId, runEmployeeId));

    if (snapshot.lines.length === 0) return;

    await db.insert(payrollLineItems).values(
      snapshot.lines.map((line) => ({
        orgId,
        runId,
        runEmployeeId,
        code: line.code,
        name: line.name,
        category: line.category,
        amount: line.amount,
        calcMethod: line.calcMethod,
        calcExplain: line.explain,
        taxable: line.taxable,
        sortOrder: line.sortOrder,
      })),
    );
  }

  async upsertExceptions(
    db: Db,
    orgId: string,
    runId: number,
    runEmployeeId: number,
    userId: string,
    exceptions: ReturnType<typeof detectExceptions>,
  ): Promise<void> {
    await db
      .delete(payrollExceptions)
      .where(and(eq(payrollExceptions.runEmployeeId, runEmployeeId), eq(payrollExceptions.status, "OPEN")));

    if (exceptions.length === 0) return;

    await db.insert(payrollExceptions).values(
      exceptions.map((ex) => ({
        orgId,
        runId,
        runEmployeeId,
        userId,
        code: ex.code,
        severity: ex.severity,
        status: "OPEN" as const,
        message: ex.message,
        metadata: ex.metadata,
      })),
    );
  }
}
