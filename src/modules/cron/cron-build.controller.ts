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
import { CronCrmLifecycleService } from "./cron-crm-lifecycle.service";
import { CronCrmAutonomyService } from "./cron-crm-autonomy.service";
import { CronBuildRetentionService } from "./cron-build-retention.service";
import { CronBuildSnapshotsService } from "./cron-build-snapshots.service";
import { CronLeaseService } from "./cron-lease.service";

@Public()
@Controller("cron")
export class CronBuildController {
  constructor(
    private readonly cronProjects: CronProjectsService,
    private readonly crmSequencesRunner: CrmSequencesRunnerService,
    private readonly crmTasks: CronCrmTasksService,
    private readonly crmLifecycle: CronCrmLifecycleService,
    private readonly crmAutonomy: CronCrmAutonomyService,
    private readonly buildRetention: CronBuildRetentionService,
    private readonly buildSnapshots: CronBuildSnapshotsService,
    private readonly cronLease: CronLeaseService,
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

  @Get("crm-lifecycle-triggers-sweep")
  getCrmLifecycleTriggersSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmLifecycleTriggersSweep(authorization);
  }

  @Post("crm-lifecycle-triggers-sweep")
  @HttpCode(200)
  postCrmLifecycleTriggersSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmLifecycleTriggersSweep(authorization);
  }

  @Get("crm-silence-sweep")
  getCrmSilenceSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmSilenceSweep(authorization);
  }

  @Post("crm-silence-sweep")
  @HttpCode(200)
  postCrmSilenceSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmSilenceSweep(authorization);
  }

  @Get("crm-field-repairs")
  getCrmFieldRepairs(@Headers("authorization") authorization?: string) {
    return this.runCrmFieldRepairs(authorization);
  }

  @Post("crm-field-repairs")
  @HttpCode(200)
  postCrmFieldRepairs(@Headers("authorization") authorization?: string) {
    return this.runCrmFieldRepairs(authorization);
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
   * The renewal book, considered.
   *
   * A 600-second lease rather than the 120 its neighbours use: this walks every
   * organisation and each contract that turns out to be due costs a provider
   * call, so a slow pass must not have a second scheduler start over the top of
   * it. The sweep is already idempotent per term — the once-per-term claim stops
   * a duplicate opportunity and the re-offer interval stops a duplicate draft —
   * so the lease is about spend and pool pressure, not correctness.
   */
  private async runCrmLifecycleTriggersSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("crm-lifecycle-triggers-sweep", 600, () =>
        this.crmLifecycle.sweepLifecycleTriggers(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "crm-lifecycle-triggers-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Considered ${result.considered} contract(s) across ${result.organizations} organization(s): opened ${result.opened}, re-offered ${result.reoffered}, held ${result.held}`,
        ...result,
      };
    } catch (error) {
      logger.error("CRM lifecycle triggers sweep failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  /**
   * Relationships that have gone quiet, handed to the outbound loop.
   *
   * 900 seconds, the longest lease here: this walks every organisation and every
   * candidate that turns out to be due costs a draft. `OUTBOUND_SPACING_DAYS`
   * already stops one loop redrafting the same nudge on every pass, so the lease
   * is about not paying twice concurrently rather than about correctness.
   */
  private async runCrmSilenceSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("crm-silence-sweep", 900, () =>
        this.crmAutonomy.sweepSilentRelationships(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "crm-silence-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Considered ${result.considered} quiet relationship(s) across ${result.organizations} organization(s): held ${result.held}, refused ${result.refused}`,
        ...result,
      };
    } catch (error) {
      logger.error("CRM silence sweep failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  /**
   * Deterministic field repairs, under each tenant's own policy.
   *
   * No provider call and no hold window, so this is the cheapest of the three and
   * takes the shortest lease.
   */
  private async runCrmFieldRepairs(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("crm-field-repairs", 300, () =>
        this.crmAutonomy.runFieldRepairs(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "crm-field-repairs already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Repaired ${result.repaired} value(s) across ${result.organizations} organization(s); ${result.leftForAPerson} left for a person`,
        ...result,
      };
    } catch (error) {
      logger.error("CRM field repairs failed", error);
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
