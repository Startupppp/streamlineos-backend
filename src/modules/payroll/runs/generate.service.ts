import { Injectable, Inject, Logger, ConflictException } from "@nestjs/common";
import { and, eq, inArray, sql, count, desc, lt, lte, or, isNotNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollExceptions,
  payrollLineItems,
  payrollRunEvents,
  payrollPolicies,
  payrollPolicyVersions,
  employeeSalaryProfiles,
  payrollRunEmployees,
  reimbursements,
  incentives,
  salaryLoans,
  users,
  payrollRunAllocations,
} from "../../../db/schema";
import { decryptBankDetails } from "../../hr/payroll/lib/encryption";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { DEFAULT_PAYROLL_TOGGLES } from "../payroll.types";
import type { PayrollToggles, PayrollPolicyConfig, CalculationSnapshot, InputsSnapshot } from "../payroll.types";
import { GeneratePipelineService, type ProfileData } from "./generate-pipeline.service";
import { PayrollNotificationsService } from "../insights/payroll-notifications.service";
import { PayrollRunLockService } from "../run-lock.service";
import { payrollSubjectKey } from "../lib/payroll-subject";
import { requirePayrollUserIds } from "../lib/payroll-user-id";
import {
  buildPulledInputsFromSections,
  getLockedInputPeriodId,
} from "./lib/input-puller";
import { getIndiaBundleForMonth } from "./lib/statutory-registry";
import { toPaise, fromPaise } from "./lib/money";

type PayrollTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class GenerateService {
  private readonly logger = new Logger(GenerateService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly pipeline: GeneratePipelineService,
    private readonly notifications: PayrollNotificationsService,
    private readonly runLocks: PayrollRunLockService,
  ) {}

  async generateRun(
    orgId: string,
    runId: number,
    actorId: string,
    isRecalc = false,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const runRows = await this.db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    const run = runRows[0];
    if (!run) return { ok: false, reason: "not_found" };

    if (PAYROLL_LOCKED_STATUSES.includes(run.status)) {
      return { ok: false, reason: "locked" };
    }

    let lockToken: string;
    try {
      lockToken = await this.runLocks.acquire(orgId, runId);
      await this.runLocks.assertNoOtherActiveGeneration(orgId, run.month, runId);
    } catch (err) {
      if (err instanceof ConflictException) {
        return { ok: false, reason: "generation_in_progress" };
      }
      throw err;
    }

    try {
      return await this.generateRunLocked(orgId, runId, actorId, isRecalc, run);
    } finally {
      await this.runLocks.release(orgId, runId, lockToken);
    }
  }

  private async generateRunLocked(
    orgId: string,
    runId: number,
    actorId: string,
    isRecalc: boolean,
    run: typeof payrollRuns.$inferSelect,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const policyResult = await this.loadPolicy(orgId, run.policyVersionId);
    if (!policyResult) return { ok: false, reason: "no_policy" };

    const { toggles, config, policyVersionId } = policyResult;

    const profiles = await this.loadEligibleProfiles(orgId, run.month, toggles);
    const eligibleUserIds = profiles
      .map((p) => p.userId)
      .filter((id): id is string => id !== null);
    const [heldUserIds, duplicateBankAccountUserIds, lockedPeriodId, statutoryFlags] =
      await Promise.all([
        this.loadHeldUserIds(orgId, runId, eligibleUserIds),
        this.findDuplicateBankAccounts(eligibleUserIds),
        getLockedInputPeriodId(this.db, orgId, run.month),
        this.loadStatutoryIdFlags(eligibleUserIds),
      ]);
    const periodLocked = lockedPeriodId != null;

    if (isRecalc) {
      await this.clearPreviouslyConsumedReimbursements(orgId, runId);
      await this.clearRunAllocations(orgId, runId);
    }

    const [batch, prevSnapshotByUser] = await Promise.all([
      this.pipeline.loadRunBatchData(orgId, runId, run.month, toggles, profiles, lockedPeriodId),
      this.loadPreviousSnapshots(orgId, eligibleUserIds, run.month),
    ]);

    type EmployeeCalcResult = {
      profile: ProfileData;
      inputs: InputsSnapshot;
      pulls: ReturnType<GeneratePipelineService["buildCalcInputsFromBatch"]>;
    } & ReturnType<GeneratePipelineService["runCalcAndDetect"]>;

    let processedCount = 0;
    let grossTotalPaise = 0;
    let deductionTotalPaise = 0;
    let employerCostTotalPaise = 0;
    let netTotalPaise = 0;
    let finalExceptionCount = 0;

    const calcResults: EmployeeCalcResult[] = [];

    for (const profile of profiles) {
      const subjectKey = payrollSubjectKey({ userId: profile.userId, workerId: profile.workerId });
      const components = batch.componentsByProfileId.get(profile.id) ?? [];
      const inputs = this.pipeline.buildInputsFromBatch(subjectKey, run.month, toggles, batch);
      const pulls = this.pipeline.buildCalcInputsFromBatch(subjectKey, toggles, batch);

      const hasAttendanceInput =
        inputs.source === "ATTENDANCE" ||
        inputs.source === "UPLOAD" ||
        inputs.source === "LEAVE" ||
        inputs.source === "TIMESHEET";
      const fromLockedSnapshot =
        inputs.overrideReason === "Locked payroll input period snapshot" ||
        (inputs.source === "UPLOAD" && Boolean(inputs.overrideReason));
      const prevSnap = prevSnapshotByUser.get(subjectKey) ?? null;

      const lockedBaselinePull =
        periodLocked && profile.userId
          ? buildPulledInputsFromSections(
              profile.userId,
              run.month,
              batch.lockedSectionsByUser.get(profile.userId),
            )
          : null;

      const { snapshot, exceptions } = this.pipeline.runCalcAndDetect(
        profile,
        components,
        inputs,
        pulls,
        toggles,
        config,
        policyVersionId,
        run.month,
        prevSnap,
        hasAttendanceInput,
        {
          isSalaryOnHold: profile.userId ? heldUserIds.has(profile.userId) : false,
          duplicateBankAccountUserIds,
          missingLockedInputPeriod:
            Boolean(toggles.requireLockedPayrollInputs) && !periodLocked,
          inputNotFromLockedSnapshot:
            Boolean(toggles.requireLockedPayrollInputs) &&
            periodLocked &&
            !fromLockedSnapshot,
          missingPfUan: profile.userId
            ? (statutoryFlags.get(profile.userId)?.missingPfUan ?? false)
            : false,
          missingEsiIp: profile.userId
            ? (statutoryFlags.get(profile.userId)?.missingEsiIp ?? false)
            : false,
          lockedInputBaseline: lockedBaselinePull
            ? {
                paidDays: lockedBaselinePull.paidDays,
                lopDays: lockedBaselinePull.lopDays,
              }
            : null,
        },
      );

      const inputsWithConsumed: InputsSnapshot = {
        ...inputs,
        consumedReimbursementIds: pulls.consumedReimbursementIds ?? [],
      };

      calcResults.push({ profile, inputs: inputsWithConsumed, pulls, snapshot, exceptions });
      grossTotalPaise += toPaise(snapshot.totals.gross);
      deductionTotalPaise += toPaise(snapshot.totals.deductions);
      employerCostTotalPaise += toPaise(snapshot.totals.employerContributions);
      netTotalPaise += toPaise(snapshot.totals.net);
      processedCount++;
    }

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
              workerId: payrollRunEmployees.workerId,
            });
          for (const row of upserted) {
            if (row.userId) {
              empIdBySubject.set(row.userId, row.id);
            }
          }
        }

        if (workerOnlyRows.length > 0) {
          for (const row of workerOnlyRows) {
            const [inserted] = await tx
              .insert(payrollRunEmployees)
              .values(row)
              .onConflictDoUpdate({
                target: [payrollRunEmployees.runId, payrollRunEmployees.workerId],
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
            if (inserted?.workerId) {
              empIdBySubject.set(`worker:${inserted.workerId}`, inserted.id);
            }
          }
        }
      }

      const allEmpIds = [...empIdBySubject.values()];

      if (allEmpIds.length > 0) {
        await tx.delete(payrollLineItems).where(inArray(payrollLineItems.runEmployeeId, allEmpIds));

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
        if (allLineRows.length > 0) {
          await tx.insert(payrollLineItems).values(allLineRows);
        }

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
        if (allExceptionRows.length > 0) {
          await tx.insert(payrollExceptions).values(allExceptionRows);
        }
      }

      const allReimbIds: number[] = [];
      const allIncentiveIds: number[] = [];
      const allAllocationRows: (typeof payrollRunAllocations.$inferInsert)[] = [];

      for (const { profile, pulls } of calcResults) {
        if (!profile.userId) continue;
        for (const [i, reimbId] of (pulls.consumedReimbursementIds ?? []).entries()) {
          allReimbIds.push(reimbId);
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

      const paidAt = new Date();
      if (allReimbIds.length > 0) {
        await tx.update(reimbursements).set({ paidAt }).where(inArray(reimbursements.id, allReimbIds));
      }
      if (allIncentiveIds.length > 0) {
        await tx.update(incentives).set({ status: "ADDED_TO_PAYROLL" }).where(inArray(incentives.id, allIncentiveIds));
      }
      if (allAllocationRows.length > 0) {
        await tx.insert(payrollRunAllocations).values(allAllocationRows).onConflictDoNothing();
      }

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
          grossTotal: fromPaise(grossTotalPaise),
          deductionTotal: fromPaise(deductionTotalPaise),
          employerCostTotal: fromPaise(employerCostTotalPaise),
          netTotal: fromPaise(netTotalPaise),
          employeeCount: processedCount,
          exceptionCount: openBlockers?.total ?? 0,
          policyVersionId,
          calculationVersion: "1.0.0",
          statutoryRuleVersion: run.statutoryRuleVersion ?? getIndiaBundleForMonth(run.month).bundleVersion,
        })
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: isRecalc ? "RECALCULATED" : "GENERATED",
        actorId,
        metadata: { employeeCount: processedCount },
      });
    });

    if (finalExceptionCount > 0) {
      this.notifications
        .notifyExceptions(orgId, actorId, runId, finalExceptionCount)
        .catch(e => this.logger.error("notifyExceptions failed", { error: e, orgId, runId }));
    }

    return { ok: true };
  }

  private async loadHeldUserIds(orgId: string, runId: number, userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db
      .select({ userId: payrollRunEmployees.userId })
      .from(payrollRunEmployees)
      .where(
        and(
          eq(payrollRunEmployees.orgId, orgId),
          eq(payrollRunEmployees.runId, runId),
          or(eq(payrollRunEmployees.status, "HELD"), isNotNull(payrollRunEmployees.holdReason)),
        ),
      );
    return new Set(requirePayrollUserIds(rows.map((r) => r.userId)));
  }

  private async findDuplicateBankAccounts(userIds: string[]): Promise<string[]> {
    if (userIds.length < 2) return [];
    const rows = await this.db
      .select({ id: users.id, bankDetails: users.bankDetails })
      .from(users)
      .where(inArray(users.id, userIds));

    const keyToUserIds = new Map<string, string[]>();
    for (const row of rows) {
      const bank = decryptBankDetails(row.bankDetails ?? null);
      const account = bank?.accountNumber?.trim().toLowerCase();
      if (!account) continue;
      const key = `${account}|${(bank?.ifsc ?? "").trim().toLowerCase()}`;
      const list = keyToUserIds.get(key) ?? [];
      list.push(row.id);
      keyToUserIds.set(key, list);
    }

    const duplicates = new Set<string>();
    for (const list of keyToUserIds.values()) {
      if (list.length > 1) list.forEach((id) => duplicates.add(id));
    }
    return [...duplicates];
  }

  /** PF UAN / ESI IP presence from encrypted user bank details (onboarding path). */
  private async loadStatutoryIdFlags(
    userIds: string[],
  ): Promise<Map<string, { missingPfUan: boolean; missingEsiIp: boolean }>> {
    const map = new Map<string, { missingPfUan: boolean; missingEsiIp: boolean }>();
    if (userIds.length === 0) return map;
    const rows = await this.db
      .select({ id: users.id, bankDetails: users.bankDetails })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const row of rows) {
      const bank = decryptBankDetails(row.bankDetails ?? null);
      const uan = bank?.pfUanNumber?.trim() ?? "";
      const ip = bank?.esiIpNumber?.trim() ?? "";
      map.set(row.id, {
        missingPfUan: !/^\d{12}$/.test(uan),
        missingEsiIp: ip.length === 0,
      });
    }
    for (const id of userIds) {
      if (!map.has(id)) map.set(id, { missingPfUan: true, missingEsiIp: true });
    }
    return map;
  }

  async postPayrollLock(orgId: string, runId: number, tx?: PayrollTx): Promise<void> {
    if (tx) {
      await this.applyLoanRecovery(orgId, runId, tx);
      return;
    }
    await this.db.transaction((t) => this.applyLoanRecovery(orgId, runId, t));
  }

  private async applyLoanRecovery(orgId: string, runId: number, tx: PayrollTx): Promise<void> {
    const empRows = await tx
      .select({ calculationSnapshot: payrollRunEmployees.calculationSnapshot })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    const loanIdSet = new Set<number>();
    for (const emp of empRows) {
      const snap = emp.calculationSnapshot as { lines?: { code: string }[] } | null;
      for (const line of snap?.lines ?? []) {
        const match = /^LOAN_EMI_(\d+)$/.exec(line.code);
        if (match?.[1]) loanIdSet.add(parseInt(match[1], 10));
      }
    }

    if (loanIdSet.size === 0) return;

    const loans = await tx
      .select({ id: salaryLoans.id, paidEmis: salaryLoans.paidEmis, totalEmis: salaryLoans.totalEmis })
      .from(salaryLoans)
      .where(and(inArray(salaryLoans.id, [...loanIdSet]), eq(salaryLoans.orgId, orgId)));

    const now = new Date();
    for (const loan of loans) {
      const newPaidEmis = loan.paidEmis + 1;
      const isRepaid = loan.totalEmis != null && newPaidEmis >= loan.totalEmis;

      const loanUpdate: Partial<typeof salaryLoans.$inferInsert> = { paidEmis: newPaidEmis };
      if (isRepaid) {
        loanUpdate.status = "REPAID";
        loanUpdate.closedAt = now;
      }

      await tx.update(salaryLoans).set(loanUpdate).where(and(eq(salaryLoans.id, loan.id), eq(salaryLoans.orgId, orgId)));
    }
  }

  private async clearPreviouslyConsumedReimbursements(orgId: string, runId: number): Promise<void> {
    const existingEmps = await this.db
      .select({ inputsSnapshot: payrollRunEmployees.inputsSnapshot })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)));

    const prevIds = existingEmps.flatMap(
      e => (e.inputsSnapshot as { consumedReimbursementIds?: number[] } | null)?.consumedReimbursementIds ?? [],
    );

    if (prevIds.length > 0) {
      await this.db
        .update(reimbursements)
        .set({ paidAt: null })
        .where(and(inArray(reimbursements.id, prevIds), eq(reimbursements.orgId, orgId)));
    }
  }

  private async clearRunAllocations(orgId: string, runId: number): Promise<void> {
    await this.db
      .delete(payrollRunAllocations)
      .where(and(eq(payrollRunAllocations.orgId, orgId), eq(payrollRunAllocations.runId, runId)));
  }

  private async loadPreviousSnapshots(
    orgId: string,
    userIds: string[],
    currentMonth: string,
  ): Promise<Map<string, CalculationSnapshot>> {
    const result = new Map<string, CalculationSnapshot>();
    if (userIds.length === 0) return result;

    const [prevRun] = await this.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.orgId, orgId),
          inArray(payrollRuns.status, [...PAYROLL_LOCKED_STATUSES]),
          lt(payrollRuns.month, currentMonth),
        ),
      )
      .orderBy(desc(payrollRuns.month))
      .limit(1);

    if (!prevRun) return result;

    const prevEmps = await this.db
      .select({
        userId: payrollRunEmployees.userId,
        calculationSnapshot: payrollRunEmployees.calculationSnapshot,
      })
      .from(payrollRunEmployees)
      .where(
        and(
          eq(payrollRunEmployees.runId, prevRun.id),
          inArray(payrollRunEmployees.userId, userIds),
        ),
      );

    for (const prevEmp of prevEmps) {
      const rawSnap = prevEmp.calculationSnapshot;
      if (
        prevEmp.userId &&
        rawSnap &&
        typeof rawSnap === "object" &&
        !result.has(prevEmp.userId)
      ) {
        result.set(prevEmp.userId, rawSnap as CalculationSnapshot);
      }
    }
    return result;
  }

  private async loadPolicy(orgId: string, policyVersionId: number | null): Promise<{
    toggles: PayrollToggles;
    config: PayrollPolicyConfig;
    policyVersionId: number;
  } | null> {
    if (policyVersionId) {
      const version = await this.db
        .select()
        .from(payrollPolicyVersions)
        .where(and(eq(payrollPolicyVersions.id, policyVersionId), eq(payrollPolicyVersions.orgId, orgId)))
        .limit(1);

      if (version[0]) {
        const rawToggles = version[0].toggles;
        const rawConfig = version[0].config;
        return {
          toggles: rawToggles && typeof rawToggles === "object"
            ? { ...DEFAULT_PAYROLL_TOGGLES, ...(rawToggles as Partial<PayrollToggles>) }
            : { ...DEFAULT_PAYROLL_TOGGLES },
          config: rawConfig && typeof rawConfig === "object" ? (rawConfig as PayrollPolicyConfig) : ({} as PayrollPolicyConfig),
          policyVersionId: version[0].id,
        };
      }
    }

    const activeVersion = await this.db
      .select()
      .from(payrollPolicies)
      .innerJoin(
        payrollPolicyVersions,
        and(
          eq(payrollPolicyVersions.policyId, payrollPolicies.id),
          eq(payrollPolicyVersions.status, "ACTIVE"),
        ),
      )
      .where(eq(payrollPolicies.orgId, orgId))
      .limit(1);

    if (!activeVersion[0]) return null;

    const rawActiveToggles = activeVersion[0].payroll_policy_versions.toggles;
    const rawActiveConfig = activeVersion[0].payroll_policy_versions.config;
    return {
      toggles: rawActiveToggles && typeof rawActiveToggles === "object"
        ? { ...DEFAULT_PAYROLL_TOGGLES, ...(rawActiveToggles as Partial<PayrollToggles>) }
        : { ...DEFAULT_PAYROLL_TOGGLES },
      config: rawActiveConfig && typeof rawActiveConfig === "object" ? (rawActiveConfig as PayrollPolicyConfig) : ({} as PayrollPolicyConfig),
      policyVersionId: activeVersion[0].payroll_policy_versions.id,
    };
  }

  private async loadEligibleProfiles(orgId: string, month: string, toggles: PayrollToggles): Promise<ProfileData[]> {
    const [year, mon] = month.split("-").map(Number);
    const lastDay = new Date(year!, mon!, 0).getDate();
    const monthEndDate = `${month}-${String(lastDay).padStart(2, "0")}`;

    const rows = await       this.db
      .select({
        id: employeeSalaryProfiles.id,
        userId: employeeSalaryProfiles.userId,
        workerId: employeeSalaryProfiles.workerId,
        workerType: employeeSalaryProfiles.workerType,
        currency: employeeSalaryProfiles.currency,
        payoutCurrency: employeeSalaryProfiles.payoutCurrency,
        annualCtc: employeeSalaryProfiles.annualCtc,
        taxRegime: employeeSalaryProfiles.taxRegime,
      })
      .from(employeeSalaryProfiles)
      .where(
        and(
          eq(employeeSalaryProfiles.orgId, orgId),
          inArray(employeeSalaryProfiles.status, ["ACTIVE", "UPCOMING"]),
          lte(employeeSalaryProfiles.effectiveFrom, monthEndDate),
        ),
      );

    const filtered = rows.filter((r) => r.id > 0);
    if (!toggles.contractorPayments) {
      return filtered.filter((r) => r.workerType !== "CONTRACTOR");
    }

    return filtered;
  }
}
