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
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { CronOperatorAccessService } from "./cron-operator-access.service";
import { CronAiUsageRetentionService } from "./cron-ai-usage-retention.service";
import { CronMailRetentionService } from "./cron-mail-retention.service";
import { CronAnnouncementsRetentionService } from "./cron-announcements-retention.service";
import {
  workflowTickResponseSchema,
  buildDueSweepResponseSchema,
  emailOutboxFlushResponseSchema,
  invitationExpiryResponseSchema,
  ownershipTransferExpiryResponseSchema,
  accountOrgIndexRebuildResponseSchema,
  orgPurgeWorkerResponseSchema,
  idempotencyFenceSweepResponseSchema,
  timesheetsExceptionDetectionResponseSchema,
  operatorGrantExpiryResponseSchema,
  aiUsageRetentionSweepResponseSchema,
  mailMetadataRetentionSweepResponseSchema,
  announcementsRetentionSweepResponseSchema,
  timesheetsRemindersResponseSchema,
  signEnvelopeSweepsResponseSchema,
} from "./dto/cron-platform-response.schemas";

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
    private readonly accountOrgIndex: AccountOrganizationIndexService,
    private readonly signSweeps: CronSignService,
    private readonly cronLease: CronLeaseService,
    private readonly operatorAccess: CronOperatorAccessService,
    private readonly aiUsageRetention: CronAiUsageRetentionService,
    private readonly mailRetention: CronMailRetentionService,
    private readonly announcementsRetention: CronAnnouncementsRetentionService,
  ) {}

  @Get("workflow-tick")
  @ResponseSchema(workflowTickResponseSchema)
  async workflowTickGet(@Headers("authorization") authorization?: string) {
    return this.runWorkflowTick(authorization);
  }

  @Post("workflow-tick")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(workflowTickResponseSchema)
  async workflowTickPost(@Headers("authorization") authorization?: string) {
    return this.runWorkflowTick(authorization);
  }

  @Get("build-due-sweep")
  @ResponseSchema(buildDueSweepResponseSchema)
  getBuildDueSweep(@Headers("authorization") authorization?: string) {
    return this.runBuildDueSweep(authorization);
  }

  @Post("build-due-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(buildDueSweepResponseSchema)
  postBuildDueSweep(@Headers("authorization") authorization?: string) {
    return this.runBuildDueSweep(authorization);
  }

  @Get("email-outbox-flush")
  @ResponseSchema(emailOutboxFlushResponseSchema)
  getEmailOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runEmailOutboxFlush(authorization);
  }

  @Post("email-outbox-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(emailOutboxFlushResponseSchema)
  postEmailOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runEmailOutboxFlush(authorization);
  }

  @Get("invitation-expiry")
  @ResponseSchema(invitationExpiryResponseSchema)
  getInvitationExpiry(@Headers("authorization") authorization?: string) {
    return this.runInvitationExpiry(authorization);
  }

  @Post("invitation-expiry")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(invitationExpiryResponseSchema)
  postInvitationExpiry(@Headers("authorization") authorization?: string) {
    return this.runInvitationExpiry(authorization);
  }

  @Get("ownership-transfer-expiry")
  @ResponseSchema(ownershipTransferExpiryResponseSchema)
  getOwnershipTransferExpiry(@Headers("authorization") authorization?: string) {
    return this.runOwnershipTransferExpiry(authorization);
  }

  @Post("ownership-transfer-expiry")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(ownershipTransferExpiryResponseSchema)
  postOwnershipTransferExpiry(@Headers("authorization") authorization?: string) {
    return this.runOwnershipTransferExpiry(authorization);
  }

  @Get("account-org-index-rebuild")
  @ResponseSchema(accountOrgIndexRebuildResponseSchema)
  getAccountOrgIndexRebuild(@Headers("authorization") authorization?: string) {
    return this.runAccountOrgIndexRebuild(authorization);
  }

  @Post("account-org-index-rebuild")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(accountOrgIndexRebuildResponseSchema)
  postAccountOrgIndexRebuild(@Headers("authorization") authorization?: string) {
    return this.runAccountOrgIndexRebuild(authorization);
  }

  @Get("org-purge-worker")
  @ResponseSchema(orgPurgeWorkerResponseSchema)
  getOrgPurgeWorker(@Headers("authorization") authorization?: string) {
    return this.runOrgPurgeWorker(authorization);
  }

  @Post("org-purge-worker")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(orgPurgeWorkerResponseSchema)
  postOrgPurgeWorker(@Headers("authorization") authorization?: string) {
    return this.runOrgPurgeWorker(authorization);
  }

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

  @Get("sign-envelope-sweeps")
  @ResponseSchema(signEnvelopeSweepsResponseSchema)
  getSignEnvelopeSweeps(@Headers("authorization") authorization?: string) {
    return this.runSignEnvelopeSweeps(authorization);
  }

  @Post("sign-envelope-sweeps")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(signEnvelopeSweepsResponseSchema)
  postSignEnvelopeSweeps(@Headers("authorization") authorization?: string) {
    return this.runSignEnvelopeSweeps(authorization);
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
