import { Injectable, Inject, Logger, ConflictException } from "@nestjs/common";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import { payrollRuns } from "../../../db/schema";
import { and, eq } from "drizzle-orm";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import type { SensitiveEmploymentFacts } from "../../directory/employment-facts.types";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { GeneratePipelineService } from "./generate-pipeline.service";
import { RunBatchLoaderService } from "./run-batch-loader.service";
import { PayrollNotificationsService } from "../insights/payroll-notifications.service";
import { PayrollRunLockService } from "../run-lock.service";
import { payrollSubjectKey } from "../lib/payroll-subject";
import { buildPulledInputsFromSections } from "./lib/input-puller";
import { toPaise } from "./lib/money";
import { PayrollRunCalculationGuardsService } from "./payroll-run-calculation-guards.service";
import { RunDataLoaderService } from "./run-data-loader.service";
import { RunResultPersisterService } from "./run-result-persister.service";
import { LoanRecoveryService } from "./loan-recovery.service";
import type { EmployeeCalcResult, GenerateRunCommand } from "./run-types";

@Injectable()
export class GenerateService {
  private readonly logger = new Logger(GenerateService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly pipeline: GeneratePipelineService,
    private readonly batchLoader: RunBatchLoaderService,
    private readonly notifications: PayrollNotificationsService,
    private readonly runLocks: PayrollRunLockService,
    private readonly efService: EmploymentFactsService,
    private readonly calculationGuards: PayrollRunCalculationGuardsService,
    private readonly dataLoader: RunDataLoaderService,
    private readonly persister: RunResultPersisterService,
    private readonly loanRecovery: LoanRecoveryService,
  ) {}

  async generateRun(
    command: GenerateRunCommand,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { orgId, runId, actorId, isRecalc } = command;
    const runRows = await this.db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    const run = runRows[0];
    if (!run) return { ok: false, reason: "not_found" };

    if (PAYROLL_LOCKED_STATUSES.includes(run.status))
      return { ok: false, reason: "locked" };

    let lockToken: string;
    try {
      lockToken = await this.runLocks.acquire(orgId, runId);
      await this.runLocks.assertNoOtherActiveGeneration(orgId, run.month, runId);
    } catch (err) {
      if (err instanceof ConflictException)
        return { ok: false, reason: "generation_in_progress" };
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
    const policyResult = await this.dataLoader.loadPolicy(orgId, run.policyVersionId);
    if (!policyResult) return { ok: false, reason: "no_policy" };

    const { toggles, config, policyVersionId } = policyResult;

    const profiles = await this.dataLoader.loadEligibleProfiles(orgId, run.month, toggles);
    const eligibleUserIds = profiles
      .map((p) => p.userId)
      .filter((id): id is string => id !== null);
    const sensitiveFacts =
      eligibleUserIds.length > 0
        ? await this.efService.getSensitiveFactsBatch(orgId, eligibleUserIds)
        : new Map<string, SensitiveEmploymentFacts>();

    const duplicateBankAccountUserIds = this.calculationGuards.findDuplicateBankAccounts(eligibleUserIds, sensitiveFacts);
    const statutoryFlags = this.calculationGuards.loadStatutoryIdFlags(eligibleUserIds, sensitiveFacts);

    const [heldUserIds, lockedPeriodId, statutoryStateCode] = await Promise.all([
      this.dataLoader.loadHeldUserIds(orgId, runId, eligibleUserIds),
      this.dataLoader.getLockedInputPeriodId(orgId, run.month),
      this.dataLoader.loadStatutoryStateCode(orgId, run.entityId ?? null),
    ]);
    const periodLocked = lockedPeriodId != null;

    if (isRecalc) {
      await this.dataLoader.clearPreviouslyConsumedReimbursements(orgId, runId);
      await this.dataLoader.clearRunAllocations(orgId, runId);
    }

    const [batch, prevSnapshotByUser] = await Promise.all([
      this.batchLoader.loadRunBatchData(orgId, runId, run.month, toggles, profiles, lockedPeriodId),
      this.dataLoader.loadPreviousSnapshots(orgId, eligibleUserIds, run.month),
    ]);

    let grossTotalPaise = 0;
    let deductionTotalPaise = 0;
    let employerCostTotalPaise = 0;
    let netTotalPaise = 0;
    let processedCount = 0;

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
          ? buildPulledInputsFromSections(profile.userId, run.month, batch.lockedSectionsByUser.get(profile.userId))
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
            ? { paidDays: lockedBaselinePull.paidDays, lopDays: lockedBaselinePull.lopDays }
            : null,
        },
        statutoryStateCode,
      );

      const inputsWithConsumed = { ...inputs, consumedReimbursementIds: pulls.consumedReimbursementIds ?? [] };

      calcResults.push({ profile, inputs: inputsWithConsumed, pulls, snapshot, exceptions });
      grossTotalPaise += toPaise(snapshot.totals.gross);
      deductionTotalPaise += toPaise(snapshot.totals.deductions);
      employerCostTotalPaise += toPaise(snapshot.totals.employerContributions);
      netTotalPaise += toPaise(snapshot.totals.net);
      processedCount++;
    }

    const { finalExceptionCount } = await this.persister.persistRunResults({
      orgId,
      runId,
      actorId,
      isRecalc,
      calcResults,
      totals: { grossTotalPaise, deductionTotalPaise, employerCostTotalPaise, netTotalPaise, processedCount },
      policyVersionId,
      statutoryRuleVersion: run.statutoryRuleVersion,
      month: run.month,
    });

    if (finalExceptionCount > 0) {
      const notifyFn = () =>
        this.notifications
          .notifyExceptions(orgId, actorId, runId, finalExceptionCount)
          .catch((e) => this.logger.error("notifyExceptions failed", { error: e, orgId, runId }));
      if (!registerAfterCommit(notifyFn)) void notifyFn();
    }

    return { ok: true };
  }

  async postPayrollLock(orgId: string, runId: number, tx?: TenantTx): Promise<void> {
    return this.loanRecovery.postPayrollLock(orgId, runId, tx);
  }
}
