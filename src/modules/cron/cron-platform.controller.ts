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
import { CronEmailOutboxService } from "./cron-email-outbox.service";
import { CronOrganizationService } from "./cron-organization.service";
import { OwnershipTransfersService } from "../ownership/ownership-transfers.service";
import { CronOrgPurgeWorkerService } from "./cron-org-purge-worker.service";
import { AccountOrganizationIndexService } from "../organization/core/account-organization-index.service";
import { CronIdempotencyService } from "./cron-idempotency.service";
import { CronWorkflowService } from "./cron-workflow.service";
import { ExceptionsDetectorService } from "../timesheets/core/exceptions-detector.service";
import { TimesheetRemindersSweepService } from "../timesheets/core/reminders-sweep.service";
import { BuildDueSweepService } from "../build/core/build-due-sweep.service";
import { CronSignService } from "./cron-sign.service";
import { CronLeaseService } from "./cron-lease.service";
import { CalendarReminderSweepService } from "../calendar/calendar-reminder-sweep.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronPlatformController {
  constructor(
    private readonly emailOutbox: CronEmailOutboxService,
    private readonly workflow: CronWorkflowService,
    private readonly cronOrganization: CronOrganizationService,
    private readonly ownershipTransfers: OwnershipTransfersService,
    private readonly orgPurgeWorker: CronOrgPurgeWorkerService,
    private readonly timesheetExceptionsDetector: ExceptionsDetectorService,
    private readonly timesheetReminders: TimesheetRemindersSweepService,
    private readonly idempotency: CronIdempotencyService,
    private readonly buildDueSweep: BuildDueSweepService,
    private readonly calendarReminderSweep: CalendarReminderSweepService,
    private readonly accountOrgIndex: AccountOrganizationIndexService,
    private readonly signSweeps: CronSignService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("workflow-tick")
  async workflowTickGet(@Headers("authorization") authorization?: string) {
    return this.runWorkflowTick(authorization);
  }

  @Post("workflow-tick")
  @BodylessAction()
  @HttpCode(200)
  async workflowTickPost(@Headers("authorization") authorization?: string) {
    return this.runWorkflowTick(authorization);
  }

  @Get("build-due-sweep")
  getBuildDueSweep(@Headers("authorization") authorization?: string) {
    return this.runBuildDueSweep(authorization);
  }

  @Post("build-due-sweep")
  @BodylessAction()
  @HttpCode(200)
  postBuildDueSweep(@Headers("authorization") authorization?: string) {
    return this.runBuildDueSweep(authorization);
  }

  @Get("calendar-reminder-sweep")
  getCalendarReminderSweep(@Headers("authorization") authorization?: string) {
    return this.runCalendarReminderSweep(authorization);
  }

  @Post("calendar-reminder-sweep")
  @BodylessAction()
  @HttpCode(200)
  postCalendarReminderSweep(@Headers("authorization") authorization?: string) {
    return this.runCalendarReminderSweep(authorization);
  }

  @Get("email-outbox-flush")
  getEmailOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runEmailOutboxFlush(authorization);
  }

  @Post("email-outbox-flush")
  @BodylessAction()
  @HttpCode(200)
  postEmailOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runEmailOutboxFlush(authorization);
  }

  @Get("invitation-expiry")
  getInvitationExpiry(@Headers("authorization") authorization?: string) {
    return this.runInvitationExpiry(authorization);
  }

  @Post("invitation-expiry")
  @BodylessAction()
  @HttpCode(200)
  postInvitationExpiry(@Headers("authorization") authorization?: string) {
    return this.runInvitationExpiry(authorization);
  }

  @Get("ownership-transfer-expiry")
  getOwnershipTransferExpiry(@Headers("authorization") authorization?: string) {
    return this.runOwnershipTransferExpiry(authorization);
  }

  @Post("ownership-transfer-expiry")
  @BodylessAction()
  @HttpCode(200)
  postOwnershipTransferExpiry(@Headers("authorization") authorization?: string) {
    return this.runOwnershipTransferExpiry(authorization);
  }

  @Get("account-org-index-rebuild")
  getAccountOrgIndexRebuild(@Headers("authorization") authorization?: string) {
    return this.runAccountOrgIndexRebuild(authorization);
  }

  @Post("account-org-index-rebuild")
  @BodylessAction()
  @HttpCode(200)
  postAccountOrgIndexRebuild(@Headers("authorization") authorization?: string) {
    return this.runAccountOrgIndexRebuild(authorization);
  }

  @Get("org-purge-worker")
  getOrgPurgeWorker(@Headers("authorization") authorization?: string) {
    return this.runOrgPurgeWorker(authorization);
  }

  @Post("org-purge-worker")
  @BodylessAction()
  @HttpCode(200)
  postOrgPurgeWorker(@Headers("authorization") authorization?: string) {
    return this.runOrgPurgeWorker(authorization);
  }

  @Get("idempotency-fence-sweep")
  getIdempotencyFenceSweep(@Headers("authorization") authorization?: string) {
    return this.runIdempotencyFenceSweep(authorization);
  }

  @Post("idempotency-fence-sweep")
  @BodylessAction()
  @HttpCode(200)
  postIdempotencyFenceSweep(@Headers("authorization") authorization?: string) {
    return this.runIdempotencyFenceSweep(authorization);
  }

  @Get("timesheets-reminders")
  getTimesheetsReminders(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsReminders(authorization);
  }

  @Post("timesheets-reminders")
  @BodylessAction()
  @HttpCode(200)
  postTimesheetsReminders(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsReminders(authorization);
  }

  @Get("timesheets-exception-detection")
  getTimesheetsExceptionDetection(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsExceptionDetection(authorization);
  }

  @Post("timesheets-exception-detection")
  @BodylessAction()
  @HttpCode(200)
  postTimesheetsExceptionDetection(@Headers("authorization") authorization?: string) {
    return this.runTimesheetsExceptionDetection(authorization);
  }

  @Get("sign-envelope-sweeps")
  getSignEnvelopeSweeps(@Headers("authorization") authorization?: string) {
    return this.runSignEnvelopeSweeps(authorization);
  }

  @Post("sign-envelope-sweeps")
  @BodylessAction()
  @HttpCode(200)
  postSignEnvelopeSweeps(@Headers("authorization") authorization?: string) {
    return this.runSignEnvelopeSweeps(authorization);
  }

  private async runWorkflowTick(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("workflow-tick", 55, async () => {
        const { relay, drain } = await this.workflow.tick();
        return { relay, drain };
      });
      if (!outcome.ran) return { ok: true, skipped: true, message: "workflow-tick already running" };
      const { relay, drain } = outcome.result;
      return {
        ok: true,
        relayed: relay.started,
        scanned: relay.scanned,
        claimed: drain.claimed,
        outcomes: drain.outcomes,
      };
    } catch (error) {
      logger.error("cron workflow tick failed", { error });
      throw new InternalServerErrorException("workflow tick failed");
    }
  }

  private async runBuildDueSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("build-due-sweep", 300, () =>
        this.buildDueSweep.sweep(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "build-due-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Build due sweep: ${result.dueSoon} due-soon, ${result.overdue} overdue`,
        ...result,
      };
    } catch (error) {
      logger.error("Build due sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runCalendarReminderSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("calendar-reminder-sweep", 120, () =>
        this.calendarReminderSweep.run(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "calendar-reminder-sweep already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Calendar reminder sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runEmailOutboxFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("email-outbox-flush", 120, () =>
        this.emailOutbox.flushOutbox(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "email-outbox-flush already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Processed ${result.processed} outbox emails: ${result.sent} sent, ${result.dead} dead`,
        ...result,
      };
    } catch (error) {
      logger.error("Email outbox flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runInvitationExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("invitation-expiry", 120, () =>
        this.cronOrganization.expireStaleInvitations(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "invitation-expiry already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Expired ${result.expired} stale invitations`,
        ...result,
      };
    } catch (error) {
      logger.error("Invitation expiry cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runOwnershipTransferExpiry(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("ownership-transfer-expiry", 120, () =>
        this.ownershipTransfers.expireStaleTransfers(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "ownership-transfer-expiry already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Expired ${result.expired} stale ownership transfers`,
        ...result,
      };
    } catch (error) {
      logger.error("Ownership transfer expiry cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runAccountOrgIndexRebuild(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease(
        "account-org-index-rebuild",
        600,
        () => this.accountOrgIndex.rebuild(),
      );
      if (!outcome.ran)
        return {
          success: true,
          skipped: true,
          message: "account-org-index-rebuild already running",
        };
      const result = outcome.result;
      return {
        success: true,
        message: `Account-org index rebuilt: ${result.organizations} orgs, ${result.succeeded} succeeded, ${result.failed} failed`,
        ...result,
      };
    } catch (error) {
      logger.error("Account-org index rebuild cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runOrgPurgeWorker(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("org-purge-worker", 600, () =>
        this.orgPurgeWorker.run(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "org-purge-worker already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Org purge worker: processed ${result.processed}, skipped ${result.skipped}`,
        ...result,
      };
    } catch (error) {
      logger.error("Org purge worker cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
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

  private async runSignEnvelopeSweeps(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("sign-envelope-sweeps", 600, () =>
        this.signSweeps.sweepEnvelopes(),
      );
      if (!outcome.ran) {
        return { success: true, skipped: true, message: "sign-envelope-sweeps already running" };
      }
      const result = outcome.result;
      return {
        success: true,
        message:
          `E-sign envelope sweeps: scanned ${result.organizations} orgs, ` +
          `expired ${result.expired}, reminded ${result.reminded}` +
          (result.failed > 0 ? `, ${result.failed} org(s) failed` : ""),
        ...result,
      };
    } catch (error) {
      logger.error("Sign envelope sweeps cron failed", error);
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
}
