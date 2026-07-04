import { Injectable, Inject, Logger } from "@nestjs/common";
import { and, eq, inArray, count, desc, lt, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollExceptions,
  payrollRunEvents,
  payrollPolicies,
  payrollPolicyVersions,
  employeeSalaryProfiles,
  payrollRunEmployees,
  reimbursements,
} from "../../../db/schema";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import type { PayrollToggles, PayrollPolicyConfig, CalculationSnapshot, InputsSnapshot } from "../payroll.types";
import { GeneratePipelineService, type ProfileData } from "./generate-pipeline.service";
import { PayrollNotificationsService } from "../insights/payroll-notifications.service";

@Injectable()
export class GenerateService {
  private readonly logger = new Logger(GenerateService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly pipeline: GeneratePipelineService,
    private readonly notifications: PayrollNotificationsService,
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

    const policyResult = await this.loadPolicy(orgId, run.policyVersionId);
    if (!policyResult) return { ok: false, reason: "no_policy" };

    const { toggles, config, policyVersionId } = policyResult;

    const profiles = await this.loadEligibleProfiles(orgId, run.month, toggles);

    if (isRecalc) {
      await this.clearPreviouslyConsumedReimbursements(orgId, runId);
    }

    let processedCount = 0;
    let grossTotal = 0;
    let deductionTotal = 0;
    let employerCostTotal = 0;
    let netTotal = 0;
    let finalExceptionCount = 0;

    await this.db.transaction(async (tx) => {
      for (const profile of profiles) {
        const [components, inputs, pulls] = await Promise.all([
          this.pipeline.loadComponents(orgId, profile.id),
          this.pipeline.pullInputs(orgId, runId, profile.userId, run.month, toggles),
          this.pipeline.pullCalcInputs(orgId, profile.userId, runId, run.month, toggles),
        ]);

        const hasAttendanceInput = inputs.source === "ATTENDANCE";
        const prevSnap = await this.getPreviousSnapshot(orgId, profile.userId, runId, run.month);

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
        );

        const inputsWithConsumed: InputsSnapshot = {
          ...inputs,
          consumedReimbursementIds: pulls.consumedReimbursementIds ?? [],
        };

        const empId = await this.pipeline.upsertRunEmployee(tx, orgId, runId, profile, inputsWithConsumed, snapshot);
        await this.pipeline.replaceLineItems(tx, orgId, runId, empId, snapshot);
        await this.pipeline.upsertExceptions(tx, orgId, runId, empId, profile.userId, exceptions);

        const consumedIds = pulls.consumedReimbursementIds ?? [];
        if (consumedIds.length > 0) {
          await tx
            .update(reimbursements)
            .set({ paidAt: new Date() })
            .where(inArray(reimbursements.id, consumedIds));
        }

        grossTotal += parseFloat(snapshot.totals.gross);
        deductionTotal += parseFloat(snapshot.totals.deductions);
        employerCostTotal += parseFloat(snapshot.totals.employerContributions);
        netTotal += parseFloat(snapshot.totals.net);
        processedCount++;
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
          grossTotal: grossTotal.toFixed(2),
          deductionTotal: deductionTotal.toFixed(2),
          employerCostTotal: employerCostTotal.toFixed(2),
          netTotal: netTotal.toFixed(2),
          employeeCount: processedCount,
          exceptionCount: openBlockers?.total ?? 0,
          policyVersionId,
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
        .where(inArray(reimbursements.id, prevIds));
    }
  }

  private async getPreviousSnapshot(
    orgId: string,
    userId: string,
    currentRunId: number,
    currentMonth: string,
  ): Promise<CalculationSnapshot | null> {
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

    if (!prevRun) return null;

    const [prevEmp] = await this.db
      .select({ calculationSnapshot: payrollRunEmployees.calculationSnapshot })
      .from(payrollRunEmployees)
      .where(
        and(
          eq(payrollRunEmployees.runId, prevRun.id),
          eq(payrollRunEmployees.userId, userId),
        ),
      )
      .limit(1);

    if (!prevEmp?.calculationSnapshot) return null;

    return prevEmp.calculationSnapshot as unknown as CalculationSnapshot;
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
        return {
          toggles: version[0].toggles as PayrollToggles,
          config: version[0].config as PayrollPolicyConfig,
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

    return {
      toggles: activeVersion[0].payroll_policy_versions.toggles as PayrollToggles,
      config: activeVersion[0].payroll_policy_versions.config as PayrollPolicyConfig,
      policyVersionId: activeVersion[0].payroll_policy_versions.id,
    };
  }

  private async loadEligibleProfiles(orgId: string, month: string, toggles: PayrollToggles): Promise<ProfileData[]> {
    const [year, mon] = month.split("-").map(Number);
    const lastDay = new Date(year!, mon!, 0).getDate();
    const monthEndDate = `${month}-${String(lastDay).padStart(2, "0")}`;

    const rows = await this.db
      .select({
        id: employeeSalaryProfiles.id,
        userId: employeeSalaryProfiles.userId,
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
