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
import { CronCrmForecastService } from "./cron-crm-forecast.service";
import { NurtureStepSenderService } from "../autonomy/sequences/nurture-step-sender.service";
import { ReportSchedulesService } from "../reporting/report-schedules.service";
import { CronBuildRetentionService } from "./cron-build-retention.service";
import { FeedbucketMediaRetentionService } from "../feedbucket/feedbucket-media-retention.service";
import { CronBuildSnapshotsService } from "./cron-build-snapshots.service";
import { CronLeaseService } from "./cron-lease.service";
import {
  projectsRecurringFlushResponseSchema,
  crmSequencesFlushResponseSchema,
  crmTasksOverdueFlushResponseSchema,
  buildRetentionPruneResponseSchema,
  feedbucketMediaRetentionResponseSchema,
  buildDailySnapshotsResponseSchema,
  crmLifecycleTriggersSweepResponseSchema,
  crmSilenceSweepResponseSchema,
  crmNurtureStepsResponseSchema,
  crmReportSchedulesResponseSchema,
  crmDealForecastResponseSchema,
  crmFieldRepairsResponseSchema,
} from "./dto/cron-build-response.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronBuildController {
  constructor(
    private readonly cronProjects: CronProjectsService,
    private readonly crmSequencesRunner: CrmSequencesRunnerService,
    private readonly crmTasks: CronCrmTasksService,
    private readonly crmLifecycle: CronCrmLifecycleService,
    private readonly crmAutonomy: CronCrmAutonomyService,
    private readonly crmForecast: CronCrmForecastService,
    private readonly nurtureSender: NurtureStepSenderService,
    private readonly reportSchedules: ReportSchedulesService,
    private readonly buildRetention: CronBuildRetentionService,
    private readonly feedbucketMediaRetention: FeedbucketMediaRetentionService,
    private readonly buildSnapshots: CronBuildSnapshotsService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("projects-recurring-flush")
  @ResponseSchema(projectsRecurringFlushResponseSchema)
  getProjectsRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runProjectsRecurringFlush(authorization);
  }

  @Post("projects-recurring-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(projectsRecurringFlushResponseSchema)
  postProjectsRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runProjectsRecurringFlush(authorization);
  }

  @Get("crm-sequences-flush")
  @ResponseSchema(crmSequencesFlushResponseSchema)
  getCrmSequencesFlush(@Headers("authorization") authorization?: string) {
    return this.runCrmSequencesFlush(authorization);
  }

  @Post("crm-sequences-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(crmSequencesFlushResponseSchema)
  postCrmSequencesFlush(@Headers("authorization") authorization?: string) {
    return this.runCrmSequencesFlush(authorization);
  }

  @Get("crm-lifecycle-triggers-sweep")
  @ResponseSchema(crmLifecycleTriggersSweepResponseSchema)
  getCrmLifecycleTriggersSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmLifecycleTriggersSweep(authorization);
  }

  @Post("crm-lifecycle-triggers-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(crmLifecycleTriggersSweepResponseSchema)
  postCrmLifecycleTriggersSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmLifecycleTriggersSweep(authorization);
  }

  @Get("crm-silence-sweep")
  @ResponseSchema(crmSilenceSweepResponseSchema)
  getCrmSilenceSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmSilenceSweep(authorization);
  }

  @Post("crm-silence-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(crmSilenceSweepResponseSchema)
  postCrmSilenceSweep(@Headers("authorization") authorization?: string) {
    return this.runCrmSilenceSweep(authorization);
  }

  @Get("crm-nurture-steps")
  @ResponseSchema(crmNurtureStepsResponseSchema)
  getCrmNurtureSteps(@Headers("authorization") authorization?: string) {
    return this.runCrmNurtureSteps(authorization);
  }

  @Post("crm-nurture-steps")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(crmNurtureStepsResponseSchema)
  postCrmNurtureSteps(@Headers("authorization") authorization?: string) {
    return this.runCrmNurtureSteps(authorization);
  }

  @Get("crm-report-schedules")
  @ResponseSchema(crmReportSchedulesResponseSchema)
  getCrmReportSchedules(@Headers("authorization") authorization?: string) {
    return this.runCrmReportSchedules(authorization);
  }

  @Post("crm-report-schedules")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(crmReportSchedulesResponseSchema)
  postCrmReportSchedules(@Headers("authorization") authorization?: string) {
    return this.runCrmReportSchedules(authorization);
  }

  @Get("crm-deal-forecast")
  @ResponseSchema(crmDealForecastResponseSchema)
  getCrmDealForecast(@Headers("authorization") authorization?: string) {
    return this.runCrmDealForecast(authorization);
  }

  @Post("crm-deal-forecast")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(crmDealForecastResponseSchema)
  postCrmDealForecast(@Headers("authorization") authorization?: string) {
    return this.runCrmDealForecast(authorization);
  }

  @Get("crm-field-repairs")
  @ResponseSchema(crmFieldRepairsResponseSchema)
  getCrmFieldRepairs(@Headers("authorization") authorization?: string) {
    return this.runCrmFieldRepairs(authorization);
  }

  @Post("crm-field-repairs")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(crmFieldRepairsResponseSchema)
  postCrmFieldRepairs(@Headers("authorization") authorization?: string) {
    return this.runCrmFieldRepairs(authorization);
  }

  @Get("crm-tasks-overdue-flush")
  @ResponseSchema(crmTasksOverdueFlushResponseSchema)
  getCrmTasksOverdueFlush(@Headers("authorization") authorization?: string) {
    return this.runCrmTasksOverdueFlush(authorization);
  }

  @Post("crm-tasks-overdue-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(crmTasksOverdueFlushResponseSchema)
  postCrmTasksOverdueFlush(@Headers("authorization") authorization?: string) {
    return this.runCrmTasksOverdueFlush(authorization);
  }

  @Get("build-retention-prune")
  @ResponseSchema(buildRetentionPruneResponseSchema)
  getBuildRetentionPrune(@Headers("authorization") authorization?: string) {
    return this.runBuildRetentionPrune(authorization);
  }

  @Post("build-retention-prune")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(buildRetentionPruneResponseSchema)
  postBuildRetentionPrune(@Headers("authorization") authorization?: string) {
    return this.runBuildRetentionPrune(authorization);
  }

  @Get("feedbucket-media-retention-sweep")
  @ResponseSchema(feedbucketMediaRetentionResponseSchema)
  getFeedbucketMediaRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runFeedbucketMediaRetentionSweep(authorization);
  }

  @Post("feedbucket-media-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(feedbucketMediaRetentionResponseSchema)
  postFeedbucketMediaRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runFeedbucketMediaRetentionSweep(authorization);
  }

  @Get("build-daily-snapshots")
  @ResponseSchema(buildDailySnapshotsResponseSchema)
  getBuildDailySnapshots(@Headers("authorization") authorization?: string) {
    return this.runBuildDailySnapshots(authorization);
  }

  @Post("build-daily-snapshots")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(buildDailySnapshotsResponseSchema)
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
   * The nurture cadences, advanced one step at a time.
   *
   * The engine was written with no caller: `sweepDueSteps` is the only thing that
   * moves an enrolment forward, so without this endpoint every enrolment sat on
   * step zero and the whole surface was an authoring screen for a sequence that
   * never ran.
   *
   * 900 seconds, matching the silence sweep and for the same reason — every due
   * step is a draft somebody pays for. The lease matters more here than there:
   * `attemptStep` claims a step before composing, so a second concurrent pass
   * loses the race rather than double-sending, but it loses it *after* deciding
   * the step was due, and a lease is cheaper than that decision.
   */
  private async runCrmNurtureSteps(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("crm-nurture-steps", 900, () =>
        this.nurtureSender.sweepDueSteps(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "crm-nurture-steps already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Considered ${result.considered} enrolment(s) across ${result.organizations} organization(s): held ${result.held}, refused ${result.refused}, exited ${result.exited}, completed ${result.completed}`,
        ...result,
      };
    } catch (error) {
      logger.error("CRM nurture step sweep failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  /**
   * Saved reports that are due, claimed and handed to the outbox.
   *
   * This sweep sends nothing and runs no report. It advances `next_run_at` and
   * writes the outbox event in one transaction, and everything after that is
   * the consumer's — running the report and posting the mail inside a sweep
   * would lose both if the process died between them, and would hold a
   * database connection for the length of an email provider's outage.
   *
   * The lease is short for the same reason the work is small: a tick that only
   * moves timestamps and inserts events finishes in milliseconds, and a long
   * lease on cheap work is a long outage when a process dies holding it. The
   * atomic advance is what actually prevents a double send, so the lease is a
   * courtesy rather than the safeguard.
   */
  private async runCrmReportSchedules(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("crm-report-schedules", 120, () =>
        this.reportSchedules.sweepDueSchedules(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "crm-report-schedules already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Claimed ${result.claimed} due schedule(s) across ${result.organizations} organization(s)`,
        ...result,
      };
    } catch (error) {
      logger.error("CRM report schedule sweep failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  /**
   * Refit the stale forecast models, then score every open pipeline.
   *
   * The longest lease of the CRM sweeps, and the only one that earns it: a fit
   * reads thousands of closed deals and their ledgers per organisation. It is
   * still a courtesy rather than a safeguard — nothing here is a send, and a
   * second pass would overwrite the same score rows with the same numbers
   * rather than doing anything twice.
   *
   * A tenant whose model is refused is counted in `refused`, not `failed`. A
   * model that could not beat the tenant's own stage percentages is the system
   * working, and folding it into an error count would make a healthy sweep look
   * broken and a broken one look healthy.
   */
  private async runCrmDealForecast(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("crm-deal-forecast", 1800, () =>
        this.crmForecast.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "crm-deal-forecast already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Trained ${result.trained}, refused ${result.refused}, scored ${result.scored} deal(s) across ${result.organizations} organization(s)`,
        ...result,
      };
    } catch (error) {
      logger.error("CRM deal forecast sweep failed", error);
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

  private async runFeedbucketMediaRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("feedbucket-media-retention-sweep", 1800, () =>
        this.feedbucketMediaRetention.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "feedbucket-media-retention-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Purged media for ${result.submissionsPurged} submission(s) across ${result.organizations} organization(s): ${result.objectsDeleted} object(s) deleted, ${result.mediaDeleteFailures} failure(s)${result.truncated ? ", more remain for the next run" : ""}`,
        ...result,
      };
    } catch (error) {
      logger.error("Feedbucket media retention sweep failed", error);
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
