import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { organizations, goals, reviewCycles, hrBenefitEnrollmentWindows, assets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { HrWorkflowEngineService } from "../hr/workflows/hr-workflow-engine.service";
import { HrEffectiveChangesService } from "../hr/core/hr-effective-changes.service";
import { HrAutomationEngineService } from "../hr/automations/hr-automation-engine.service";
import { HrWebhooksService } from "../hr/automations/hr-webhooks.service";
import { ProbationService } from "../hr/lifecycle/probation.service";
import { ComplianceRequirementsService } from "../hr/global/compliance-requirements.service";
import { WorkAuthorizationsService } from "../hr/global/work-authorizations.service";
import { ContractsService } from "../hr/global/contracts.service";

interface SweepResult {
  orgId: string;
  sweep: string;
  ok: boolean;
  error?: string;
}

interface RunAllResult {
  results: SweepResult[];
  orgsProcessed: number;
  succeeded: number;
  failed: number;
}

@Injectable()
export class CronHrEnginesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly workflowEngine: HrWorkflowEngineService,
    private readonly effectiveChanges: HrEffectiveChangesService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly hrWebhooks: HrWebhooksService,
    private readonly probation: ProbationService,
    private readonly compliance: ComplianceRequirementsService,
    private readonly workAuths: WorkAuthorizationsService,
    private readonly contracts: ContractsService,
  ) {}

  private async listOrgIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.status, "ACTIVE"), isNull(organizations.deletedAt)));
    return rows.map((r) => r.id);
  }

  async sweepWorkflowSlaEscalations(): Promise<{ swept: number }> {
    return this.workflowEngine.sweepOverdueSteps();
  }

  async sweepEffectiveDatedChanges(orgId: string): Promise<{ applied: number }> {
    return this.effectiveChanges.applyDueChanges(orgId);
  }

  async sweepOverdueGoals(orgId: string): Promise<{ swept: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const overdueGoals = await this.db
      .select({ id: goals.id, userId: goals.userId, endDate: goals.endDate })
      .from(goals)
      .where(and(eq(goals.orgId, orgId), eq(goals.status, "IN_PROGRESS"), lt(goals.endDate, today)))
      .limit(200);

    for (const goal of overdueGoals) {
      const daysPastDue = Math.ceil(
        (Date.now() - new Date(goal.endDate).getTime()) / 86_400_000,
      );
      await this.hrAutomation.emit(orgId, "goal.overdue", {
        employeeId: goal.userId,
        goalId: goal.id,
        daysPastDue,
      });
    }

    return { swept: overdueGoals.length };
  }

  async sweepReviewsDue(orgId: string): Promise<{ swept: number }> {
    const horizonDate = new Date();
    horizonDate.setDate(horizonDate.getDate() + 7);
    const horizon = horizonDate.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const dueCycles = await this.db
      .select({ id: reviewCycles.id, name: reviewCycles.name, deadline: reviewCycles.deadline })
      .from(reviewCycles)
      .where(
        and(
          eq(reviewCycles.orgId, orgId),
          ne(reviewCycles.status, "COMPLETED"),
          ne(reviewCycles.status, "CANCELLED"),
          sql`${reviewCycles.deadline} IS NOT NULL`,
          lte(reviewCycles.deadline, horizon),
          sql`${reviewCycles.deadline} >= ${today}`,
        ),
      )
      .limit(100);

    for (const cycle of dueCycles) {
      await this.hrAutomation.emit(orgId, "review.due", {
        cycleId: cycle.id,
        cycleName: cycle.name,
        deadline: cycle.deadline,
      });
    }

    return { swept: dueCycles.length };
  }

  async sweepAssetReturnsDue(orgId: string): Promise<{ swept: number }> {
    const horizonDate = new Date();
    horizonDate.setDate(horizonDate.getDate() + 3);
    const horizon = horizonDate.toISOString().slice(0, 10);

    const dueAssets = await this.db
      .select({
        id: assets.id,
        type: assets.type,
        assignedTo: assets.assignedTo,
        expectedReturnDate: assets.expectedReturnDate,
      })
      .from(assets)
      .where(
        and(
          eq(assets.orgId, orgId),
          inArray(assets.status, ["ASSIGNED", "MAINTENANCE"]),
          isNotNull(assets.expectedReturnDate),
          lte(assets.expectedReturnDate, horizon),
        ),
      )
      .limit(200);

    for (const asset of dueAssets) {
      if (!asset.assignedTo || !asset.expectedReturnDate) continue;
      const daysUntilDue = Math.ceil(
        (new Date(asset.expectedReturnDate).getTime() - Date.now()) / 86_400_000,
      );
      await this.hrAutomation.emit(orgId, "asset.return_due", {
        employeeId: asset.assignedTo,
        assetType: asset.type,
        daysUntilDue,
      });
    }

    return { swept: dueAssets.length };
  }

  async sweepEnrollmentWindows(orgId: string): Promise<{ closed: number }> {
    const result = await this.db
      .update(hrBenefitEnrollmentWindows)
      .set({ status: "closed" })
      .where(
        and(
          eq(hrBenefitEnrollmentWindows.orgId, orgId),
          eq(hrBenefitEnrollmentWindows.status, "open"),
          lte(hrBenefitEnrollmentWindows.closesAt, new Date()),
        ),
      )
      .returning({ id: hrBenefitEnrollmentWindows.id });

    return { closed: result.length };
  }

  async runAll(): Promise<RunAllResult> {
    const orgIds = await this.listOrgIds();
    const results: SweepResult[] = [];

    const sweepWorkflow = await this.runSweepAllOrgs("workflow-sla", async () => {
      const r = await this.sweepWorkflowSlaEscalations();
      logger.info("HR workflow SLA sweep complete", r);
    });
    results.push(sweepWorkflow);

    const sweepWebhooks = await this.runSweepAllOrgs("webhook-retries", async () => {
      await this.hrWebhooks.retryPending();
    });
    results.push(sweepWebhooks);

    for (const orgId of orgIds) {
      const effectiveResult = await this.runSweep(orgId, "effective-changes", () =>
        this.sweepEffectiveDatedChanges(orgId),
      );
      results.push(effectiveResult);

      const goalsResult = await this.runSweep(orgId, "overdue-goals", () =>
        this.sweepOverdueGoals(orgId),
      );
      results.push(goalsResult);

      const probationResult = await this.runSweep(orgId, "probation-due", () =>
        this.probation.sweepDue(orgId),
      );
      results.push(probationResult);

      const reviewsDueResult = await this.runSweep(orgId, "reviews-due", () =>
        this.sweepReviewsDue(orgId),
      );
      results.push(reviewsDueResult);

      const enrollmentWindowsResult = await this.runSweep(orgId, "enrollment-windows", () =>
        this.sweepEnrollmentWindows(orgId),
      );
      results.push(enrollmentWindowsResult);

      const assetReturnsDueResult = await this.runSweep(orgId, "asset-returns-due", () =>
        this.sweepAssetReturnsDue(orgId),
      );
      results.push(assetReturnsDueResult);

      const complianceEventsResult = await this.runSweep(orgId, "compliance-events", async () => {
        await this.compliance.generateEvents(orgId);
        await this.compliance.markOverdueEvents(orgId);
      });
      results.push(complianceEventsResult);

      const workAuthResult = await this.runSweep(orgId, "work-auth-expiry", () =>
        this.workAuths.refreshExpiredStatuses(orgId),
      );
      results.push(workAuthResult);

      const contractsResult = await this.runSweep(orgId, "contract-expiry", () =>
        this.contracts.refreshExpiredStatuses(orgId),
      );
      results.push(contractsResult);
    }

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    return { results, orgsProcessed: orgIds.length, succeeded, failed };
  }

  private async runSweep(
    orgId: string,
    sweep: string,
    fn: () => Promise<unknown>,
  ): Promise<SweepResult> {
    try {
      await fn();
      return { orgId, sweep, ok: true };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`HR engines sweep failed`, { orgId, sweep, error });
      return { orgId, sweep, ok: false, error };
    }
  }

  private async runSweepAllOrgs(
    sweep: string,
    fn: () => Promise<void>,
  ): Promise<SweepResult> {
    try {
      await fn();
      return { orgId: "*", sweep, ok: true };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`HR engines sweep (all-orgs) failed`, { sweep, error });
      return { orgId: "*", sweep, ok: false, error };
    }
  }
}
