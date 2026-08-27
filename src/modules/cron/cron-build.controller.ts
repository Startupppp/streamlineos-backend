import {
  Controller,
  Get,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Post,
} from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { assertCronSecret } from "./cron-secret";
import { CronProjectsService } from "./cron-projects.service";
import { CrmSequencesRunnerService } from "../crm/automation-studio/crm-sequences-runner.service";
import { CronCrmTasksService } from "./cron-crm-tasks.service";
import { CronBuildRetentionService } from "./cron-build-retention.service";
import { CronBuildSnapshotsService } from "./cron-build-snapshots.service";
import { CronLeaseService } from "./cron-lease.service";
import { CallAnalysisSweepService } from "../call-analysis/analyse/call-analysis-sweep.service";
import { CronCrmLifecycleService } from "./cron-crm-lifecycle.service";

@Public()
@Controller("cron")
export class CronBuildController {
  constructor(
    private readonly cronProjects: CronProjectsService,
    private readonly crmSequencesRunner: CrmSequencesRunnerService,
    private readonly crmTasks: CronCrmTasksService,
    private readonly buildRetention: CronBuildRetentionService,
    private readonly buildSnapshots: CronBuildSnapshotsService,
    private readonly cronLease: CronLeaseService,
    private readonly callAnalysis: CallAnalysisSweepService,
    private readonly crmLifecycle: CronCrmLifecycleService,
  ) {}

  @Get("projects-recurring-flush")
  getProjectsRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runProjectsRecurringFlush(authorization);
  }

  @Post("projects-recurring-flush")
  @HttpCode(200)
  postProjectsRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runProjectsRecurringFlush(authorization);
  }

  @Get("crm-sequences-flush")
  getCrmSequencesFlush(@Headers("authorization") authorization?: string) {
    return this.runCrmSequencesFlush(authorization);
  }

  @Post("crm-sequences-flush")
  @HttpCode(200)
  postCrmSequencesFlush(@Headers("authorization") authorization?: string) {
    return this.runCrmSequencesFlush(authorization);
  }

  @Get("call-analysis-sweep")
  getCallAnalysisSweep(@Headers("authorization") authorization?: string) {
    return this.runCallAnalysisSweep(authorization);
  }

  @Post("call-analysis-sweep")
  @HttpCode(200)
  postCallAnalysisSweep(@Headers("authorization") authorization?: string) {
    return this.runCallAnalysisSweep(authorization);
  }

  @Get("crm-lifecycle-sweep")
  getCrmLifecycleSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmLifecycleSweep(authorization);
  }

  @Post("crm-lifecycle-sweep")
  @HttpCode(200)
  postCrmLifecycleSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmLifecycleSweep(authorization);
  }

  @Get("crm-tasks-overdue-flush")
  getCrmTasksOverdueFlush(@Headers("authorization") authorization?: string) {
    return this.runCrmTasksOverdueFlush(authorization);
  }

  @Post("crm-tasks-overdue-flush")
  @HttpCode(200)
  postCrmTasksOverdueFlush(@Headers("authorization") authorization?: string) {
    return this.runCrmTasksOverdueFlush(authorization);
  }

  @Get("build-retention-prune")
  getBuildRetentionPrune(@Headers("authorization") authorization?: string) {
    return this.runBuildRetentionPrune(authorization);
  }

  @Post("build-retention-prune")
  @HttpCode(200)
  postBuildRetentionPrune(@Headers("authorization") authorization?: string) {
    return this.runBuildRetentionPrune(authorization);
  }

  @Get("build-daily-snapshots")
  getBuildDailySnapshots(@Headers("authorization") authorization?: string) {
    return this.runBuildDailySnapshots(authorization);
  }

  @Post("build-daily-snapshots")
  @HttpCode(200)
  postBuildDailySnapshots(@Headers("authorization") authorization?: string) {
    return this.runBuildDailySnapshots(authorization);
  }

  private async runProjectsRecurringFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("projects-recurring-flush", 300, () =>
        this.cronProjects.spawnDueRecurringTickets(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "projects-recurring-flush already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Spawned ${result.spawned} recurring tickets, advanced ${result.advanced} schedules`,
        ...result,
      };
    } catch (error) {
      logger.error("Projects recurring flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runCrmSequencesFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("crm-sequences-flush", 300, () =>
        this.crmSequencesRunner.flushDueEnrollments(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "crm-sequences-flush already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `CRM sequences flush: processed ${result.processed}, advanced ${result.advanced}, stopped ${result.stopped}`,
        ...result,
      };
    } catch (error) {
      logger.error("CRM sequences flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  /**
   * Phase 5, ticket 01. Analysis runs here and nowhere else.
   *
   * The lease window is long because the sweep starts one durable workflow run
   * per organisation and the model calls inside them are the single largest
   * cost in the product — a second sweep overlapping the first would pay for
   * every one of them twice. The workflow itself is idempotent on the hour key,
   * so an overlap would not corrupt anything; it would only be expensive, which
   * is reason enough.
   */
  private async runCallAnalysisSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("call-analysis-sweep", 900, () =>
        this.callAnalysis.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "call-analysis-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Call analysis sweep: ${result.organizations} organisations, ${result.runs} runs`,
        ...result,
      };
    } catch (error) {
      logger.error("Call analysis sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  /**
   * Phase 5, tickets 07 and 09.
   *
   * Without this, a closed-won deal produces a lifecycle record only when
   * somebody happens to POST to the endpoint — which is to say never — and the
   * renewal triggers that depend on those records have nothing to read.
   */
  private async runCrmLifecycleSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("crm-lifecycle-sweep", 600, () =>
        this.crmLifecycle.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "crm-lifecycle-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message:
          `CRM lifecycle sweep: ${result.organizations} organisations, ` +
          `${result.lifecyclesOpened} lifecycles opened, ${result.triggersFired} renewals triggered`,
        ...result,
      };
    } catch (error) {
      logger.error("CRM lifecycle sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runCrmTasksOverdueFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("crm-tasks-overdue-flush", 120, () =>
        this.crmTasks.flushOverdueTasks(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "crm-tasks-overdue-flush already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Emitted ${result.emitted} task.overdue events`,
        ...result,
      };
    } catch (error) {
      logger.error("CRM tasks overdue flush failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runBuildRetentionPrune(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("build-retention-prune", 120, () =>
        this.buildRetention.pruneWebhookDeliveries(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "build-retention-prune already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Pruned ${result.webhookDeliveriesPruned} webhook delivery rows`,
        ...result,
      };
    } catch (error) {
      logger.error("Build retention prune cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runBuildDailySnapshots(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("build-daily-snapshots", 600, () =>
        this.buildSnapshots.snapshotAllProjects(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "build-daily-snapshots already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Snapshotted ${result.projectsProcessed} projects across ${result.orgsVisited} orgs (${result.projectsFailed} failed, ${result.projectsSkipped} skipped)`,
        ...result,
      };
    } catch (error) {
      logger.error("Build daily snapshots cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
