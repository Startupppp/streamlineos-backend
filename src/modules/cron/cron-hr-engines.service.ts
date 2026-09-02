import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNotNull, lte, lt, ne, sql } from "drizzle-orm";
import { Redis } from "@upstash/redis";
import { goals, reviewCycles, hrBenefitEnrollmentWindows, assets } from "../../db/schema";
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
import { forEachOrg } from "../../common/tenant";
import { REDIS } from "../../common/cache/cache.service";
import { RotatingCursor, drainWithCursor } from "./drain";

const GOAL_PAGE = 200;
const REVIEW_PAGE = 100;
const ASSET_PAGE = 200;
/**
 * The per-tick budget. These sweeps emit an automation event and mark nothing, so
 * without a resumable cursor the same first page matched every tick and everything
 * past it was never emitted at all. The budget keeps one tick bounded; the cursor
 * makes the coverage complete across ticks.
 */
const MAX_PAGES_PER_TICK = 5;

export interface EmitSweepResult {
  swept: number;
  /** The per-tick budget was spent with rows still eligible; the next tick resumes. */
  truncated: boolean;
}

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
  private readonly goalCursor: RotatingCursor;
  private readonly reviewCursor: RotatingCursor;
  private readonly assetCursor: RotatingCursor;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) redis: Redis | null,
    private readonly workflowEngine: HrWorkflowEngineService,
    private readonly effectiveChanges: HrEffectiveChangesService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly hrWebhooks: HrWebhooksService,
    private readonly probation: ProbationService,
    private readonly compliance: ComplianceRequirementsService,
    private readonly workAuths: WorkAuthorizationsService,
    private readonly contracts: ContractsService,
  ) {
    this.goalCursor = new RotatingCursor(redis, "hr-engines-overdue-goals");
    this.reviewCursor = new RotatingCursor(redis, "hr-engines-reviews-due");
    this.assetCursor = new RotatingCursor(redis, "hr-engines-asset-returns");
  }

  async sweepWorkflowSlaEscalations(): Promise<{ swept: number }> {
    return this.workflowEngine.sweepOverdueSteps();
  }

  async sweepEffectiveDatedChanges(orgId: string): Promise<{ applied: number }> {
    return this.effectiveChanges.applyDueChanges(orgId, null, { limit: 50 });
  }

  async sweepOverdueGoals(orgId: string): Promise<EmitSweepResult> {
    const today = new Date().toISOString().slice(0, 10);
    const outcome = await drainWithCursor(
      this.goalCursor,
      orgId,
      GOAL_PAGE,
      MAX_PAGES_PER_TICK,
      (after, limit) =>
        this.db
          .select({ id: goals.id, userId: goals.userId, endDate: goals.endDate })
          .from(goals)
          .where(
            and(
              eq(goals.orgId, orgId),
              eq(goals.status, "IN_PROGRESS"),
              lt(goals.endDate, today),
              gt(goals.id, after),
            ),
          )
          .orderBy(asc(goals.id))
          .limit(limit),
      async (rows) => {
        for (const goal of rows) {
          const daysPastDue = Math.ceil(
            (Date.now() - new Date(goal.endDate).getTime()) / 86_400_000,
          );
          await this.hrAutomation.emit(orgId, "goal.overdue", {
            employeeId: goal.userId,
            goalId: goal.id,
            daysPastDue,
          });
        }
      },
    );

    return { swept: outcome.emitted, truncated: outcome.truncated };
  }

  async sweepReviewsDue(orgId: string): Promise<EmitSweepResult> {
    const horizonDate = new Date();
    horizonDate.setDate(horizonDate.getDate() + 7);
    const horizon = horizonDate.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const outcome = await drainWithCursor(
      this.reviewCursor,
      orgId,
      REVIEW_PAGE,
      MAX_PAGES_PER_TICK,
      (after, limit) =>
        this.db
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
              gt(reviewCycles.id, after),
            ),
          )
          .orderBy(asc(reviewCycles.id))
          .limit(limit),
      async (rows) => {
        for (const cycle of rows) {
          await this.hrAutomation.emit(orgId, "review.due", {
            cycleId: cycle.id,
            cycleName: cycle.name,
            deadline: cycle.deadline,
          });
        }
      },
    );

    return { swept: outcome.emitted, truncated: outcome.truncated };
  }

  async sweepAssetReturnsDue(orgId: string): Promise<EmitSweepResult> {
    const horizonDate = new Date();
    horizonDate.setDate(horizonDate.getDate() + 3);
    const horizon = horizonDate.toISOString().slice(0, 10);

    const outcome = await drainWithCursor(
      this.assetCursor,
      orgId,
      ASSET_PAGE,
      MAX_PAGES_PER_TICK,
      (after, limit) =>
        this.db
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
              gt(assets.id, after),
            ),
          )
          .orderBy(asc(assets.id))
          .limit(limit),
      async (rows) => {
        for (const asset of rows) {
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
      },
    );

    return { swept: outcome.emitted, truncated: outcome.truncated };
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
    const results: SweepResult[] = [];

    results.push(
      await this.runSweepAllOrgs("workflow-sla", async () => {
        const r = await this.sweepWorkflowSlaEscalations();
        logger.info("HR workflow SLA sweep complete", r);
      }),
    );

    results.push(
      await this.runSweepAllOrgs("webhook-retries", async () => {
        await this.hrWebhooks.retryPending();
      }),
    );

    const { organizations: orgsProcessed } = await forEachOrg(
      this.db,
      "hr-engines-per-org",
      async (_tx, orgId) => {
        results.push(
          await this.runSweep(orgId, "effective-changes", () => this.sweepEffectiveDatedChanges(orgId)),
        );
        results.push(
          await this.runSweep(orgId, "overdue-goals", () => this.sweepOverdueGoals(orgId)),
        );
        results.push(
          await this.runSweep(orgId, "probation-due", () => this.probation.sweepDue(orgId)),
        );
        results.push(
          await this.runSweep(orgId, "reviews-due", () => this.sweepReviewsDue(orgId)),
        );
        results.push(
          await this.runSweep(orgId, "enrollment-windows", () => this.sweepEnrollmentWindows(orgId)),
        );
        results.push(
          await this.runSweep(orgId, "asset-returns-due", () => this.sweepAssetReturnsDue(orgId)),
        );
        results.push(
          await this.runSweep(orgId, "compliance-events", async () => {
            await this.compliance.generateEvents(orgId);
            await this.compliance.markOverdueEvents(orgId);
          }),
        );
        results.push(
          await this.runSweep(orgId, "work-auth-expiry", () => this.workAuths.refreshExpiredStatuses(orgId)),
        );
        results.push(
          await this.runSweep(orgId, "contract-expiry", () => this.contracts.refreshExpiredStatuses(orgId)),
        );
      },
    );

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    return { results, orgsProcessed, succeeded, failed };
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

  // These delegates query tenant tables cross-org, so each org gets its own pass
  private async runSweepAllOrgs(
    sweep: string,
    fn: () => Promise<void>,
  ): Promise<SweepResult> {
    try {
      const { failed } = await forEachOrg(this.db, sweep, fn);
      if (failed > 0) {
        return { orgId: "*", sweep, ok: false, error: `${failed} organization(s) failed` };
      }
      return { orgId: "*", sweep, ok: true };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`HR engines sweep (all-orgs) failed`, { sweep, error });
      return { orgId: "*", sweep, ok: false, error };
    }
  }
}
