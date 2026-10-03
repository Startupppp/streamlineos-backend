import { Injectable, Inject } from "@nestjs/common";
import { and, count, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import {
  payrollRuns,
  payrollExceptions,
  payrollLineItems,
  payrollRunEvents,
  payrollRunEmployees,
  incentives,
  payrollRunAllocations,
} from "../../../db/schema";
import { fromPaise, toPaise } from "./lib/money";
import { payrollSubjectKey } from "../lib/payroll-subject";
import { getIndiaBundleForMonth } from "./lib/statutory-registry";
import type { EmployeeCalcResult } from "./run-types";

export interface RunTotals {
  grossTotalPaise: number;
  deductionTotalPaise: number;
  employerCostTotalPaise: number;
  netTotalPaise: number;
  processedCount: number;
}

@Injectable()
export class RunResultPersisterService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async persistRunResults(params: {
    orgId: string;
    runId: number;
    actorId: string;
    isRecalc: boolean;
    calcResults: EmployeeCalcResult[];
    totals: RunTotals;
    policyVersionId: number;
    statutoryRuleVersion: string | null;
    month: string;
  }): Promise<{ finalExceptionCount: number }> {
    const { orgId, runId, actorId, isRecalc, calcResults, totals, policyVersionId, statutoryRuleVersion, month } = params;
    let finalExceptionCount = 0;

    await this.db.transaction(async (tx) => {
      const empIdBySubject = new Map<string, number>();

      if (calcResults.length > 0) {
        const userRows = calcResults
          .filter(({ profile }) => profile.userId !== null)
          .map(({ profile, inputs, snapshot }) => ({
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
          }));

        const workerOnlyRows = calcResults
          .filter(({ profile }) => profile.userId === null && profile.workerId !== null)
          .map(({ profile, inputs, snapshot }) => ({
            orgId,
            runId,
            userId: null,
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
          }));

        if (userRows.length > 0) {
          const upserted = await tx
            .insert(payrollRunEmployees)
            .values(userRows)
            .onConflictDoUpdate({
              target: [payrollRunEmployees.runId, payrollRunEmployees.userId],
              set: {
                workerId: sql`excluded.worker_id`,
                profileId: sql`excluded.profile_id`,
                workerType: sql`excluded.worker_type`,
                currency: sql`excluded.currency`,
                payoutCurrency: sql`excluded.payout_currency`,
                fxRate: sql`excluded.fx_rate`,
                netPayoutCurrency: sql`excluded.net_payout_currency`,
                scheduledDays: sql`excluded.scheduled_days`,
                paidDays: sql`excluded.paid_days`,
                lopDays: sql`excluded.lop_days`,
                overtimeHours: sql`excluded.overtime_hours`,
                gross: sql`excluded.gross`,
                totalDeductions: sql`excluded.total_deductions`,
                employerContributions: sql`excluded.employer_contributions`,
                net: sql`excluded.net`,
                inputsSnapshot: sql`excluded.inputs_snapshot`,
                calculationSnapshot: sql`excluded.calculation_snapshot`,
              },
            })
            .returning({
              id: payrollRunEmployees.id,
              userId: payrollRunEmployees.userId,
            });
          for (const row of upserted) {
            if (row.userId) empIdBySubject.set(row.userId, row.id);
          }
        }

        if (workerOnlyRows.length > 0) {
          const upserted = await tx
            .insert(payrollRunEmployees)
            .values(workerOnlyRows)
            .onConflictDoUpdate({
              target: [payrollRunEmployees.runId, payrollRunEmployees.workerId],
              targetWhere: sql`${payrollRunEmployees.workerId} is not null`,
              set: {
                profileId: sql`excluded.profile_id`,
                workerType: sql`excluded.worker_type`,
                currency: sql`excluded.currency`,
                payoutCurrency: sql`excluded.payout_currency`,
                fxRate: sql`excluded.fx_rate`,
                netPayoutCurrency: sql`excluded.net_payout_currency`,
                scheduledDays: sql`excluded.scheduled_days`,
                paidDays: sql`excluded.paid_days`,
                lopDays: sql`excluded.lop_days`,
                overtimeHours: sql`excluded.overtime_hours`,
                gross: sql`excluded.gross`,
                totalDeductions: sql`excluded.total_deductions`,
                employerContributions: sql`excluded.employer_contributions`,
                net: sql`excluded.net`,
                inputsSnapshot: sql`excluded.inputs_snapshot`,
                calculationSnapshot: sql`excluded.calculation_snapshot`,
              },
            })
            .returning({ id: payrollRunEmployees.id, workerId: payrollRunEmployees.workerId });
          for (const row of upserted)
            if (row.workerId) empIdBySubject.set(`worker:${row.workerId}`, row.id);
        }
      }

      const allEmpIds = [...empIdBySubject.values()];

      if (allEmpIds.length > 0) {
        await this.persistLineItemsAndExceptions(tx, orgId, runId, calcResults, empIdBySubject, allEmpIds);
      }

      await this.persistAllocations(tx, orgId, runId, calcResults);

      const [openBlockers] = await tx
        .select({ total: count() })
        .from(payrollExceptions)
        .where(
          and(
            eq(payrollExceptions.runId, runId),
            eq(payrollExceptions.status, "OPEN"),
            eq(payrollExceptions.severity, "BLOCKER"),
          ),
        );

      finalExceptionCount = openBlockers?.total ?? 0;
      const newStatus = finalExceptionCount > 0 ? "EXCEPTIONS_FOUND" : "PREVIEW_READY";

      await tx
        .update(payrollRuns)
        .set({
          status: newStatus,
          grossTotal: fromPaise(totals.grossTotalPaise),
          deductionTotal: fromPaise(totals.deductionTotalPaise),
          employerCostTotal: fromPaise(totals.employerCostTotalPaise),
          netTotal: fromPaise(totals.netTotalPaise),
          employeeCount: totals.processedCount,
          exceptionCount: openBlockers?.total ?? 0,
          policyVersionId,
          calculationVersion: "1.0.0",
          statutoryRuleVersion: statutoryRuleVersion ?? getIndiaBundleForMonth(month).bundleVersion,
        })
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: isRecalc ? "RECALCULATED" : "GENERATED",
        actorId,
        metadata: { employeeCount: totals.processedCount },
      });
    });

    return { finalExceptionCount };
  }

  private async persistLineItemsAndExceptions(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    runId: number,
    calcResults: EmployeeCalcResult[],
    empIdBySubject: Map<string, number>,
    allEmpIds: number[],
  ): Promise<void> {
    await tx
      .delete(payrollLineItems)
      .where(
        and(
          eq(payrollLineItems.orgId, orgId),
          inArray(payrollLineItems.runEmployeeId, allEmpIds),
        ),
      );

    const allLineRows = calcResults.flatMap(({ profile, snapshot }) => {
      const empId = empIdBySubject.get(
        payrollSubjectKey({ userId: profile.userId, workerId: profile.workerId }),
      );
      if (empId === undefined) return [];
      return snapshot.lines.map((line) => ({
        orgId,
        runId,
        runEmployeeId: empId,
        code: line.code,
        name: line.name,
        category: line.category,
        amount: line.amount,
        calcMethod: line.calcMethod,
        calcExplain: line.explain,
        taxable: line.taxable,
        sortOrder: line.sortOrder,
      }));
    });
    if (allLineRows.length > 0) await tx.insert(payrollLineItems).values(allLineRows);

    await tx
      .delete(payrollExceptions)
      .where(
        and(
          inArray(payrollExceptions.runEmployeeId, allEmpIds),
          eq(payrollExceptions.status, "OPEN"),
        ),
      );

    const allExceptionRows = calcResults.flatMap(({ profile, exceptions }) => {
      const empId = empIdBySubject.get(
        payrollSubjectKey({ userId: profile.userId, workerId: profile.workerId }),
      );
      if (empId === undefined) return [];
      return exceptions.map((ex) => ({
        orgId,
        runId,
        runEmployeeId: empId,
        userId: profile.userId,
        code: ex.code,
        severity: ex.severity,
        status: "OPEN" as const,
        message: ex.message,
        metadata: ex.metadata,
      }));
    });
    if (allExceptionRows.length > 0) await tx.insert(payrollExceptions).values(allExceptionRows);
  }

  private async persistAllocations(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    runId: number,
    calcResults: EmployeeCalcResult[],
  ): Promise<void> {
    const allIncentiveIds: number[] = [];
    const allAllocationRows: (typeof payrollRunAllocations.$inferInsert)[] = [];

    for (const { profile, pulls } of calcResults) {
      if (!profile.userId) continue;
      for (const [i, reimbId] of (pulls.consumedReimbursementIds ?? []).entries()) {
        allAllocationRows.push({
          orgId,
          runId,
          userId: profile.userId,
          sourceType: "REIMBURSEMENT",
          sourceId: String(reimbId),
          amount: pulls.approvedReimbursements[i]?.amount ?? "0",
        });
      }

      for (const [i, incentiveId] of (pulls.consumedIncentiveIds ?? []).entries()) {
        allIncentiveIds.push(incentiveId);
        allAllocationRows.push({
          orgId,
          runId,
          userId: profile.userId,
          sourceType: "INCENTIVE",
          sourceId: String(incentiveId),
          amount: pulls.approvedIncentives[i]?.amount ?? "0",
        });
      }

      for (const [i, bonusId] of (pulls.consumedBonusIds ?? []).entries()) {
        allAllocationRows.push({
          orgId,
          runId,
          userId: profile.userId,
          sourceType: "BONUS",
          sourceId: String(bonusId),
          amount: pulls.approvedBonuses[i]?.amount ?? "0",
        });
      }

      for (const loan of pulls.activeLoans) {
        allAllocationRows.push({
          orgId,
          runId,
          userId: profile.userId,
          sourceType: "LOAN",
          sourceId: String(loan.id),
          amount: loan.emiAmount ?? "0",
        });
      }
    }

    if (allIncentiveIds.length > 0)
      await tx.update(incentives).set({ status: "ADDED_TO_PAYROLL" }).where(inArray(incentives.id, allIncentiveIds));
    if (allAllocationRows.length > 0)
      await tx.insert(payrollRunAllocations).values(allAllocationRows).onConflictDoNothing();
  }
}
