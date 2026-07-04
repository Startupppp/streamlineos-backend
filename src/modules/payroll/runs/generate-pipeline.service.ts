import { Injectable, Inject } from "@nestjs/common";
import { and, eq, inArray, isNull, gte, lte } from "drizzle-orm";
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
} from "../../../db/schema";
import type { PayrollPolicyConfig, PayrollToggles, CalculationSnapshot, InputsSnapshot } from "../payroll.types";
import { calcPayroll, type ResolvedComponent, type CalcInputPulls } from "./lib/calculation-engine";
import { detectExceptions, type ExceptionInput } from "./lib/exception-engine";
import { pullAttendanceInputs } from "./lib/input-puller";
import { daysInMonth } from "./lib/money";

export interface ProfileData {
  id: number;
  userId: string;
  workerType: "EMPLOYEE" | "CONTRACTOR" | "CONSULTANT" | "INTERN" | "EOR";
  currency: string;
  payoutCurrency: string | null;
  annualCtc: string;
  taxRegime: "OLD" | "NEW" | null;
}

@Injectable()
export class GeneratePipelineService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async pullInputs(orgId: string, runId: number, userId: string, month: string, toggles: PayrollToggles): Promise<InputsSnapshot> {
    const existing = await this.db
      .select()
      .from(payrollInputs)
      .where(and(eq(payrollInputs.runId, runId), eq(payrollInputs.userId, userId)))
      .limit(1);

    if (existing[0]) {
      return {
        source: existing[0].source,
        scheduledDays: existing[0].scheduledDays,
        paidDays: existing[0].paidDays,
        lopDays: existing[0].lopDays,
        halfDays: existing[0].halfDays,
        overtimeHours: existing[0].overtimeHours,
        shiftAllowanceUnits: existing[0].shiftAllowanceUnits,
        holidayWorkDays: existing[0].holidayWorkDays,
        billableHours: existing[0].billableHours,
        isOverride: existing[0].isOverride,
        overrideReason: existing[0].overrideReason,
      };
    }

    if (toggles.lopFromAttendance) {
      const pulled = await pullAttendanceInputs(this.db, orgId, userId, month);
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
          overrideReason: null,
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

  async pullCalcInputs(orgId: string, userId: string, runId: number, month: string, toggles: PayrollToggles): Promise<CalcInputPulls> {
    const approvedBonuses = toggles.bonuses
      ? await this.db
          .select({ amount: bonuses.amount, type: bonuses.type })
          .from(bonuses)
          .where(and(eq(bonuses.orgId, orgId), eq(bonuses.userId, userId), eq(bonuses.status, "APPROVED"), eq(bonuses.month, month)))
      : [];

    const [year, mon] = month.split("-").map(Number);
    const monthStart = new Date(year!, mon! - 1, 1);
    const monthEnd = new Date(year!, mon!, 0, 23, 59, 59, 999);

    const rawIncentives = toggles.incentives
      ? await this.db
          .select({
            approvedAmount: incentives.approvedAmount,
            calculatedAmount: incentives.calculatedAmount,
          })
          .from(incentives)
          .where(
            and(
              eq(incentives.orgId, orgId),
              eq(incentives.salesRepId, userId),
              eq(incentives.status, "APPROVED"),
              gte(incentives.approvedAt, monthStart),
              lte(incentives.approvedAt, monthEnd),
            ),
          )
      : [];

    const approvedIncentives = rawIncentives.map(i => ({
      amount: i.approvedAmount ?? i.calculatedAmount,
    }));

    const rawReimbursements = toggles.reimbursements
      ? await this.db
          .select({ id: reimbursements.id, amount: reimbursements.amount, category: reimbursements.category })
          .from(reimbursements)
          .where(
            and(
              eq(reimbursements.orgId, orgId),
              eq(reimbursements.userId, userId),
              eq(reimbursements.status, "APPROVED"),
              isNull(reimbursements.paidAt),
            ),
          )
      : [];

    const activeLoans = toggles.loans
      ? await this.loadLoansWithAdjustments(orgId, userId, runId)
      : [];

    return {
      approvedBonuses: approvedBonuses.map((b) => ({ amount: b.amount, type: b.type })),
      approvedIncentives,
      approvedReimbursements: rawReimbursements.map((r) => ({ amount: r.amount, category: r.category })),
      consumedReimbursementIds: rawReimbursements.map(r => r.id),
      activeLoans,
    };
  }

  private async loadLoansWithAdjustments(orgId: string, userId: string, runId: number) {
    const loans = await this.db
      .select()
      .from(salaryLoans)
      .where(and(eq(salaryLoans.orgId, orgId), eq(salaryLoans.userId, userId), eq(salaryLoans.status, "ACTIVE")));

    if (loans.length === 0) return [];

    const loanIds = loans.map((l) => l.id);
    const adjustments = await this.db
      .select()
      .from(payrollLoanAdjustments)
      .where(and(eq(payrollLoanAdjustments.runId, runId), inArray(payrollLoanAdjustments.loanId, loanIds)));

    return loans.map((loan) => {
      const adj = adjustments.find((a) => a.loanId === loan.id);
      return {
        id: loan.id,
        emiAmount: loan.emiAmount,
        amount: loan.amount,
        paidEmis: loan.paidEmis,
        totalEmis: loan.totalEmis,
        adjustment: adj ? { type: adj.type, amount: adj.amount } : null,
      };
    });
  }

  async loadComponents(orgId: string, profileId: number): Promise<ResolvedComponent[]> {
    const rows = await this.db
      .select({
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
      .where(and(eq(employeeSalaryProfileComponents.profileId, profileId), eq(employeeSalaryProfileComponents.orgId, orgId)))
      .orderBy(salaryComponents.sortOrder);

    return rows.map((r) => ({
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
    }));
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

    const exceptionInput: ExceptionInput = {
      orgId: "",
      runId: 0,
      runEmployeeId: 0,
      userId: profile.userId,
      hasProfile: true,
      hasBankAccount: true,
      snapshot,
      toggles,
      scheduledDays: parseFloat(inputs.scheduledDays),
      lopDays: parseFloat(inputs.lopDays),
      varianceThresholdPercent: config.varianceThresholdPercent ?? 20,
      hasAttendanceInput,
      hasApprovedTaxDeclaration: true,
      isJoiningInMonth: false,
      isExitInMonth: false,
      missingFxRate,
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
  ): Promise<number> {
    const existing = await db
      .select({ id: payrollRunEmployees.id })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.userId, profile.userId)))
      .limit(1);

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
          inputsSnapshot: inputs as unknown as Record<string, unknown>,
          calculationSnapshot: snapshot as unknown as Record<string, unknown>,
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
        inputsSnapshot: inputs as unknown as Record<string, unknown>,
        calculationSnapshot: snapshot as unknown as Record<string, unknown>,
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
        calcExplain: line.explain as unknown as Record<string, unknown>,
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
