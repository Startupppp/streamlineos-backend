import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lt } from "drizzle-orm";
import { organizations, goals } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { HrWorkflowEngineService } from "../hr-workflows/hr-workflow-engine.service";
import { HrEffectiveChangesService } from "../hr-core/hr-effective-changes.service";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";
import { ProbationService } from "../hr-lifecycle/probation.service";

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
    private readonly probation: ProbationService,
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

  async runAll(): Promise<RunAllResult> {
    const orgIds = await this.listOrgIds();
    const results: SweepResult[] = [];

    const sweepWorkflow = await this.runSweepAllOrgs("workflow-sla", async () => {
      const r = await this.sweepWorkflowSlaEscalations();
      logger.info("HR workflow SLA sweep complete", r);
    });
    results.push(sweepWorkflow);

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
