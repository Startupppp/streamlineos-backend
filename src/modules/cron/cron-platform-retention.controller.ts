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
import { CronIdempotencyService } from "./cron-idempotency.service";
import { ExceptionsDetectorService } from "../timesheets/core/exceptions-detector.service";
import { TimesheetRemindersSweepService } from "../timesheets/core/reminders-sweep.service";
import { TimesheetApprovalEscalationSweepService } from "../timesheets/core/approval-escalation-sweep.service";
import { CronLeaseService } from "./cron-lease.service";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { CronOperatorAccessService } from "./cron-operator-access.service";
import { CronAiUsageRetentionService } from "./cron-ai-usage-retention.service";
import { CronMailRetentionService } from "./cron-mail-retention.service";
import { CronAnnouncementsRetentionService } from "./cron-announcements-retention.service";
import {
  idempotencyFenceSweepResponseSchema,
  timesheetsExceptionDetectionResponseSchema,
  operatorGrantExpiryResponseSchema,
  aiUsageRetentionSweepResponseSchema,
  mailMetadataRetentionSweepResponseSchema,
  announcementsRetentionSweepResponseSchema,
  timesheetsRemindersResponseSchema,
  timesheetsApprovalEscalationResponseSchema,
} from "./dto/cron-platform-response.schemas";

@Public()
@Controller("cron")
export class CronPlatformRetentionController {
  constructor(
    private readonly timesheetExceptionsDetector: ExceptionsDetectorService,
    private readonly timesheetReminders: TimesheetRemindersSweepService,
    private readonly timesheetEscalation: TimesheetApprovalEscalationSweepService,
    private readonly idempotency: CronIdempotencyService,
    private readonly cronLease: CronLeaseService,
    private readonly operatorAccess: CronOperatorAccessService,
    private readonly aiUsageRetention: CronAiUsageRetentionService,
    private readonly mailRetention: CronMailRetentionService,
    private readonly announcementsRetention: CronAnnouncementsRetentionService,
  ) {}

  @Get("idempotency-fence-sweep")
  @ResponseSchema(idempotencyFenceSweepResponseSchema)
  getIdempotencyFenceSweep(@Headers("authorization") authorization?: string) {
    return this.runIdempotencyFenceSweep(authorization);
  }

  @Post("idempotency-fence-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(idempotencyFenceSweepResponseSchema)
  postIdempotencyFenceSweep(@Headers("authorization") authorization?: string) {
    return this.runIdempotencyFenceSweep(authorization);
  }

  @Get("timesheets-reminders")
  @ResponseSchema(timesheetsRemindersResponseSchema)
  getTimesheetsReminders(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsReminders(authorization);
  }

  @Post("timesheets-reminders")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(timesheetsRemindersResponseSchema)
  postTimesheetsReminders(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsReminders(authorization);
  }

  @Get("timesheets-approval-escalation")
  @ResponseSchema(timesheetsApprovalEscalationResponseSchema)
  getTimesheetsApprovalEscalation(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsApprovalEscalation(authorization);
  }

  @Post("timesheets-approval-escalation")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(timesheetsApprovalEscalationResponseSchema)
  postTimesheetsApprovalEscalation(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsApprovalEscalation(authorization);
  }

  @Get("timesheets-exception-detection")
  @ResponseSchema(timesheetsExceptionDetectionResponseSchema)
  getTimesheetsExceptionDetection(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsExceptionDetection(authorization);
  }

  @Post("timesheets-exception-detection")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(timesheetsExceptionDetectionResponseSchema)
  postTimesheetsExceptionDetection(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsExceptionDetection(authorization);
  }

  @Get("operator-grant-expiry")
  @ResponseSchema(operatorGrantExpiryResponseSchema)
  getOperatorGrantExpiry(@Headers("authorization") authorization?: string) {
    return this.runOperatorGrantExpiry(authorization);
  }

  @Post("operator-grant-expiry")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(operatorGrantExpiryResponseSchema)
  postOperatorGrantExpiry(@Headers("authorization") authorization?: string) {
    return this.runOperatorGrantExpiry(authorization);
  }

  @Get("ai-usage-retention-sweep")
  @ResponseSchema(aiUsageRetentionSweepResponseSchema)
  getAiUsageRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runAiUsageRetentionSweep(authorization);
  }

  @Post("ai-usage-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(aiUsageRetentionSweepResponseSchema)
  postAiUsageRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runAiUsageRetentionSweep(authorization);
  }

  @Get("mail-metadata-retention-sweep")
  @ResponseSchema(mailMetadataRetentionSweepResponseSchema)
  getMailMetadataRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runMailMetadataRetentionSweep(authorization);
  }

  @Post("mail-metadata-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(mailMetadataRetentionSweepResponseSchema)
  postMailMetadataRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runMailMetadataRetentionSweep(authorization);
  }

  @Get("announcements-retention-sweep")
  @ResponseSchema(announcementsRetentionSweepResponseSchema)
  getAnnouncementsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runAnnouncementsRetentionSweep(authorization);
  }

  @Post("announcements-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(announcementsRetentionSweepResponseSchema)
  postAnnouncementsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runAnnouncementsRetentionSweep(authorization);
  }

  private async runIdempotencyFenceSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("idempotency-fence-sweep", 120, () =>
        this.idempotency.pruneExpiredFences(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "idempotency-fence-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Pruned ${result.commandFencesPruned} command fences, ${result.invKeysPruned} inv idempotency keys, ${result.payrollReceiptsPruned} payroll receipts`,
        ...result,
      };
    } catch (error) {
      logger.error("Idempotency fence sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  /**
   * Reminders for unsubmitted timesheet periods.
   *
   * 600s lease, matching the detection sweep beside it: both walk every
   * organisation and a second copy starting underneath the first would send
   * every reminder twice. The notification dedupe window is a day, so a double
   * run would be caught there too — but relying on the second line of defence
   * to cover a missing first one is how both end up load-bearing.
   */
  private async runTimesheetsReminders(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("timesheets-reminders", 600, () =>
        this.timesheetReminders.remindAllOrgs(),
      );
      if (!outcome.ran) {
        return { success: true, skipped: true, message: "timesheets-reminders already running" };
      }
      const result = outcome.result;
      return {
        success: true,
        message:
          `Timesheet reminders: scanned ${result.orgsScanned} orgs, ` +
          `sent ${result.remindersSent} of ${result.periodsConsidered} open periods` +
          (result.orgsMalformed > 0
            ? `, ${result.orgsMalformed} org(s) have unreadable reminder rules`
            : ""),
        ...result,
      };
    } catch (error) {
      logger.error("Timesheet reminders cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runTimesheetsApprovalEscalation(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("timesheets-approval-escalation", 600, () =>
        this.timesheetEscalation.escalateAllOrgs(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "timesheets-approval-escalation already running" };
      const result = outcome.result;
      return {
        success: true,
        message:
          `Timesheet approval escalation: scanned ${result.orgsScanned} orgs, ` +
          `escalated ${result.periodsEscalated} of ${result.periodsOverdue} overdue periods` +
          (result.periodsUnowned > 0 ? `, ${result.periodsUnowned} could not be re-routed` : ""),
        ...result,
      };
    } catch (error) {
      logger.error("Timesheet approval escalation cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runTimesheetsExceptionDetection(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("timesheets-exception-detection", 600, () =>
        this.timesheetExceptionsDetector.detectAllOrgs(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "timesheets-exception-detection already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Timesheet exception detection: scanned ${result.orgsScanned} orgs, created ${result.created} exceptions`,
        ...result,
      };
    } catch (error) {
      logger.error("Timesheet exception detection cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runOperatorGrantExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("operator-grant-expiry", 120, () =>
        this.operatorAccess.expirePendingGrants(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "operator-grant-expiry already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Operator grant expiry cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runAiUsageRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("ai-usage-retention-sweep", 1800, () =>
        this.aiUsageRetention.sweep({ dryRun: false }),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "ai-usage-retention-sweep already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("AI usage retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runMailMetadataRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("mail-metadata-retention-sweep", 1800, () =>
        this.mailRetention.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "mail-metadata-retention-sweep already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Mail metadata retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runAnnouncementsRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("announcements-retention-sweep", 1800, () =>
        this.announcementsRetention.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "announcements-retention-sweep already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Announcements retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
