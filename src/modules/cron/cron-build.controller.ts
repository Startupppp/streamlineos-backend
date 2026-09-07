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
import { CronFinanceService } from "./cron-finance.service";
import { CronCrmTasksService } from "./cron-crm-tasks.service";
import { CronBuildRetentionService } from "./cron-build-retention.service";
import { CronBuildSnapshotsService } from "./cron-build-snapshots.service";
import { CronLeaseService } from "./cron-lease.service";
import {
  projectsRecurringFlushResponseSchema,
  crmSequencesFlushResponseSchema,
  financeRecurringFlushResponseSchema,
  financeDueChecksResponseSchema,
  financeDepreciationResponseSchema,
  crmTasksOverdueFlushResponseSchema,
  buildRetentionPruneResponseSchema,
  buildDailySnapshotsResponseSchema,
} from "./dto/cron-build-response.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronBuildController {
  constructor(
    private readonly cronProjects: CronProjectsService,
    private readonly crmSequencesRunner: CrmSequencesRunnerService,
    private readonly cronFinance: CronFinanceService,
    private readonly crmTasks: CronCrmTasksService,
    private readonly buildRetention: CronBuildRetentionService,
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

  @Get("finance-recurring-flush")
  @ResponseSchema(financeRecurringFlushResponseSchema)
  getFinanceRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runFinanceRecurringFlush(authorization);
  }

  @Post("finance-recurring-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(financeRecurringFlushResponseSchema)
  postFinanceRecurringFlush(@Headers("authorization") authorization?: string) {
    return this.runFinanceRecurringFlush(authorization);
  }

  @Get("finance-due-checks")
  @ResponseSchema(financeDueChecksResponseSchema)
  getFinanceDueChecks(@Headers("authorization") authorization?: string) {
    return this.runFinanceDueChecks(authorization);
  }

  @Post("finance-due-checks")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(financeDueChecksResponseSchema)
  postFinanceDueChecks(@Headers("authorization") authorization?: string) {
    return this.runFinanceDueChecks(authorization);
  }

  @Get("finance-depreciation")
  @ResponseSchema(financeDepreciationResponseSchema)
  getFinanceDepreciation(@Headers("authorization") authorization?: string) {
    return this.runFinanceDepreciation(authorization);
  }

  @Post("finance-depreciation")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(financeDepreciationResponseSchema)
  postFinanceDepreciation(@Headers("authorization") authorization?: string) {
    return this.runFinanceDepreciation(authorization);
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

  private async runFinanceRecurringFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("finance-recurring-flush", 300, () =>
        this.cronFinance.runRecurringFlush(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "finance-recurring-flush already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Finance recurring flush: ${result.ran.join(", ")} — ${result.errors.length} error(s)`,
        ...result,
      };
    } catch (error) {
      logger.error("Finance recurring flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runFinanceDueChecks(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("finance-due-checks", 300, () =>
        this.cronFinance.runDueChecks(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "finance-due-checks already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Finance due checks: ${result.ran.join(", ")} — ${result.errors.length} error(s)`,
        ...result,
      };
    } catch (error) {
      logger.error("Finance due checks cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runFinanceDepreciation(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("finance-depreciation", 300, () =>
        this.cronFinance.runDepreciation(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "finance-depreciation already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Finance depreciation: ${result.ran.join(", ")} — ${result.errors.length} error(s)`,
        ...result,
      };
    } catch (error) {
      logger.error("Finance depreciation cron failed", error);
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
