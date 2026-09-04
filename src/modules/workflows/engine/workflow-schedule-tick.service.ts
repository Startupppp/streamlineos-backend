import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { TenantTx } from "../../../db/drizzle.types";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  workflowExecutions,
  workflowSchedules,
  workflows,
  workflowVersions,
} from "../../../db/schema";
import { forEachOrg, type ForEachOrgResult } from "../../../common/tenant/for-each-org";
import { computeNextCronDate } from "./cron-next";

/**
 * Most due schedules one organisation may claim in a single tick.
 *
 * The read was uncapped: every enabled schedule whose `next_run_at` had passed was
 * pulled into memory for every organisation in the deployment, on a cron that runs
 * on a fixed interval. One tenant with a large schedule table — or any tenant after
 * an outage, when every schedule is simultaneously overdue — decided the tick's
 * memory and duration for everyone behind it in `forEachOrg`.
 *
 * The cap is not a truncation: the read is ordered by `next_run_at` ascending with
 * NULLs first, so the most overdue schedules claim first and the remainder are still
 * due on the next tick. A saturated page is logged rather than passed over in
 * silence, because a tenant permanently at the cap is a capacity signal, not a
 * steady state.
 */
export const SCHEDULE_TICK_MAX_PER_ORG = 500;

export interface SchedulesTickResult {
  orgsScanned: number;
  schedulesTriggered: number;
  schedulesFailed: number;
}

type DueSchedule = {
  id: string;
  workflowId: string;
  cronExpression: string;
  timezone: string;
  nextRunAt: Date | null;
};

@Injectable()
export class WorkflowScheduleTickService {
  private readonly logger = new Logger(WorkflowScheduleTickService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async schedulesTick(): Promise<SchedulesTickResult> {
    const now = new Date();
    let schedulesTriggered = 0;
    let schedulesFailed = 0;

    const orgResult: ForEachOrgResult = await forEachOrg(
      this.db,
      "workflow-schedules-tick",
      async (tx, orgId) => {
        const { triggered, failed } = await this.tickOrg(tx, orgId, now);
        schedulesTriggered += triggered;
        schedulesFailed += failed;
      },
    );

    if (schedulesTriggered > 0 || schedulesFailed > 0)
      this.logger.log(
        `Schedules tick — triggered ${String(schedulesTriggered)}, failed ${String(schedulesFailed)}`,
      );

    return {
      orgsScanned: orgResult.organizations,
      schedulesTriggered,
      schedulesFailed,
    };
  }

  private async tickOrg(
    tx: TenantTx,
    orgId: string,
    now: Date,
  ): Promise<{ triggered: number; failed: number }> {
    const dueSchedules = await tx
      .select({
        id: workflowSchedules.id,
        workflowId: workflowSchedules.workflowId,
        cronExpression: workflowSchedules.cronExpression,
        timezone: workflowSchedules.timezone,
        nextRunAt: workflowSchedules.nextRunAt,
      })
      .from(workflowSchedules)
      .where(
        and(
          eq(workflowSchedules.orgId, orgId),
          eq(workflowSchedules.isEnabled, true),
          or(isNull(workflowSchedules.nextRunAt), lte(workflowSchedules.nextRunAt, now)),
        ),
      )
      .orderBy(sql`${workflowSchedules.nextRunAt} ASC NULLS FIRST`, asc(workflowSchedules.id))
      .limit(SCHEDULE_TICK_MAX_PER_ORG);

    if (dueSchedules.length === SCHEDULE_TICK_MAX_PER_ORG)
      this.logger.warn(
        `Schedule tick hit the per-org cap of ${String(SCHEDULE_TICK_MAX_PER_ORG)}; the remainder stay due for the next tick`,
        { orgId },
      );

    let triggered = 0;
    let failed = 0;

    for (const schedule of dueSchedules) {
      try {
        const fired = await this.triggerSchedule(tx, orgId, schedule, now);
        if (fired) triggered += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(`Failed to trigger schedule ${schedule.id}`, {
          orgId,
          scheduleId: schedule.id,
          cause: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { triggered, failed };
  }

  private async triggerSchedule(
    tx: TenantTx,
    orgId: string,
    schedule: DueSchedule,
    now: Date,
  ): Promise<boolean> {
    const nextRunAt = computeNextCronDate(schedule.cronExpression, schedule.timezone, now);

    const [claimed] = await tx
      .update(workflowSchedules)
      .set({ nextRunAt: nextRunAt ?? null, lastRunAt: now, updatedAt: now })
      .where(
        and(
          eq(workflowSchedules.id, schedule.id),
          eq(workflowSchedules.orgId, orgId),
          eq(workflowSchedules.isEnabled, true),
          or(isNull(workflowSchedules.nextRunAt), lte(workflowSchedules.nextRunAt, now)),
        ),
      )
      .returning({ id: workflowSchedules.id });

    if (!claimed) return false;

    const [workflow] = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.id, schedule.workflowId),
          eq(workflows.orgId, orgId),
          eq(workflows.status, "published"),
        ),
      )
      .limit(1);

    if (!workflow) {
      this.logger.warn(
        `Schedule ${schedule.id} references an unpublished workflow; execution not created`,
        { orgId, scheduleId: schedule.id, workflowId: schedule.workflowId },
      );
      return true;
    }

    const [latestVersion] = await tx
      .select({ id: workflowVersions.id })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.workflowId, schedule.workflowId),
          eq(workflowVersions.orgId, orgId),
        ),
      )
      .orderBy(desc(workflowVersions.version))
      .limit(1);

    if (!latestVersion) {
      this.logger.warn(
        `Schedule ${schedule.id} has no workflow version; execution not created`,
        { orgId, scheduleId: schedule.id, workflowId: schedule.workflowId },
      );
      return true;
    }

    await tx.insert(workflowExecutions).values({
      workflowId: schedule.workflowId,
      workflowVersionId: latestVersion.id,
      orgId,
      status: "pending",
      triggerType: "schedule",
      triggeredBy: null,
    });

    return true;
  }
}
