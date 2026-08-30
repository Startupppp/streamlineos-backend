import { Injectable } from "@nestjs/common";
import type { PayrollPolicyConfig, PayrollToggles, CalculationSnapshot, InputsSnapshot } from "../payroll.types";
import { calcPayroll, type CalcInputPulls, type ResolvedComponent } from "./lib/calculation-engine";
import { detectExceptions, type ExceptionInput } from "./lib/exception-engine";
import {
  buildCalcPullsFromSections,
  buildPulledInputsFromSections,
} from "./lib/input-puller";
import { daysInMonth } from "./lib/money";
import { payrollSubjectKey, isWorkerOnlySubject } from "../lib/payroll-subject";
import type { ProfileData, RunBatchData } from "./run-types";

@Injectable()
export class GeneratePipelineService {
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
}
