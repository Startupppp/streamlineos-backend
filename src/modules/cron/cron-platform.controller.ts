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
import { CronNotificationDeliveryService } from "./cron-notification-delivery.service";
import { CronNotificationRetentionService } from "./cron-notification-retention.service";
import { NotificationRetentionService } from "../notifications/notification-retention.service";
import { NotificationOutboxRelayService } from "../notifications/notification-outbox-relay.service";
import { NotificationDigestService } from "../notifications/notification-digest.service";
import { CronOrganizationService } from "./cron-organization.service";
import { OwnershipTransfersService } from "../ownership/ownership-transfers.service";
import { CronOrgPurgeWorkerService } from "./cron-org-purge-worker.service";
import { AccountOrganizationIndexService } from "../organization/core/account-organization-index.service";
import { CronIdempotencyService } from "./cron-idempotency.service";
import { CronWorkflowService } from "./cron-workflow.service";
import { ChatReplyRemindersService } from "../chat/chat-reply-reminders.service";
import { ExceptionsDetectorService } from "../timesheets/core/exceptions-detector.service";
import { BuildDueSweepService } from "../build/core/build-due-sweep.service";
import { CrmFollowupSweepService } from "../crm/core/crm-followup-sweep.service";
import { NotificationTimeSweepsService } from "../notifications/time-sweeps/notification-time-sweeps.service";
import { CronLeaseService } from "./cron-lease.service";
import { CalendarReminderSweepService } from "../calendar/calendar-reminder-sweep.service";

@Public()
@Controller("cron")
export class CronPlatformController {
  constructor(
    private readonly chatReplyReminders: ChatReplyRemindersService,
    private readonly emailOutbox: CronEmailOutboxService,
    private readonly workflow: CronWorkflowService,
    private readonly notificationDelivery: CronNotificationDeliveryService,
    private readonly cronOrganization: CronOrganizationService,
    private readonly ownershipTransfers: OwnershipTransfersService,
    private readonly orgPurgeWorker: CronOrgPurgeWorkerService,
    private readonly timesheetExceptionsDetector: ExceptionsDetectorService,
    private readonly idempotency: CronIdempotencyService,
    private readonly notificationRetention: CronNotificationRetentionService,
    private readonly partitionRetention: NotificationRetentionService,
    private readonly outboxRelay: NotificationOutboxRelayService,
    private readonly digest: NotificationDigestService,
    private readonly buildDueSweep: BuildDueSweepService,
    private readonly crmFollowupSweep: CrmFollowupSweepService,
    private readonly timeSweeps: NotificationTimeSweepsService,
    private readonly accountOrgIndex: AccountOrganizationIndexService,
    private readonly calendarReminderSweep: CalendarReminderSweepService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("notification-time-sweeps")
  getNotificationTimeSweeps(@Headers("authorization") authorization?: string) {
    return this.runNotificationTimeSweeps(authorization);
  }

  @Post("notification-time-sweeps")
  @HttpCode(200)
  postNotificationTimeSweeps(@Headers("authorization") authorization?: string) {
    return this.runNotificationTimeSweeps(authorization);
  }

  @Get("workflow-tick")
  async workflowTickGet(@Headers("authorization") authorization?: string) {
    return this.runWorkflowTick(authorization);
  }

  @Post("workflow-tick")
  @HttpCode(200)
  async workflowTickPost(@Headers("authorization") authorization?: string) {
    return this.runWorkflowTick(authorization);
  }

  @Get("build-due-sweep")
  getBuildDueSweep(@Headers("authorization") authorization?: string) {
    return this.runBuildDueSweep(authorization);
  }

  @Post("build-due-sweep")
  @HttpCode(200)
  postBuildDueSweep(@Headers("authorization") authorization?: string) {
    return this.runBuildDueSweep(authorization);
  }

  @Get("notification-digest-flush")
  getNotificationDigestFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationDigestFlush(authorization);
  }

  @Post("notification-digest-flush")
  @HttpCode(200)
  postNotificationDigestFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationDigestFlush(authorization);
  }

  @Get("notification-outbox-flush")
  getNotificationOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationOutboxFlush(authorization);
  }

  @Post("notification-outbox-flush")
  @HttpCode(200)
  postNotificationOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationOutboxFlush(authorization);
  }

  @Get("calendar-reminder-sweep")
  getCalendarReminderSweep(@Headers("authorization") authorization?: string) {
    return this.runCalendarReminderSweep(authorization);
  }

  @Post("calendar-reminder-sweep")
  @HttpCode(200)
  postCalendarReminderSweep(@Headers("authorization") authorization?: string) {
    return this.runCalendarReminderSweep(authorization);
  }

  @Get("notifications-retention-sweep")
  getNotificationsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionSweep(authorization);
  }

  @Post("notifications-retention-sweep")
  @HttpCode(200)
  postNotificationsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionSweep(authorization);
  }

  @Get("notifications-retention-detach")
  getNotificationsRetentionDetach(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionDetach(authorization);
  }

  @Post("notifications-retention-detach")
  @HttpCode(200)
  postNotificationsRetentionDetach(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionDetach(authorization);
  }

  @Get("chat-reply-reminders")
  getChatReplyReminders(@Headers("authorization") authorization?: string) {
    return this.runChatReplyReminders(authorization);
  }

  @Post("chat-reply-reminders")
  @HttpCode(200)
  postChatReplyReminders(@Headers("authorization") authorization?: string) {
    return this.runChatReplyReminders(authorization);
  }

  @Get("email-outbox-flush")
  getEmailOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runEmailOutboxFlush(authorization);
  }

  @Post("email-outbox-flush")
  @HttpCode(200)
  postEmailOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runEmailOutboxFlush(authorization);
  }

  @Get("notification-delivery-flush")
  getNotificationDeliveryFlush(
    @Headers("authorization") authorization?: string,
  ) {
    return this.runNotificationDeliveryFlush(authorization);
  }

  @Post("notification-delivery-flush")
  @HttpCode(200)
  postNotificationDeliveryFlush(
    @Headers("authorization") authorization?: string,
  ) {
    return this.runNotificationDeliveryFlush(authorization);
  }

  @Get("invitation-expiry")
  getInvitationExpiry(@Headers("authorization") authorization?: string) {
    return this.runInvitationExpiry(authorization);
  }

  @Post("invitation-expiry")
  @HttpCode(200)
  postInvitationExpiry(@Headers("authorization") authorization?: string) {
    return this.runInvitationExpiry(authorization);
  }

  @Get("ownership-transfer-expiry")
  getOwnershipTransferExpiry(@Headers("authorization") authorization?: string) {
    return this.runOwnershipTransferExpiry(authorization);
  }

  @Post("ownership-transfer-expiry")
  @HttpCode(200)
  postOwnershipTransferExpiry(@Headers("authorization") authorization?: string) {
    return this.runOwnershipTransferExpiry(authorization);
  }

  @Get("account-org-index-rebuild")
  getAccountOrgIndexRebuild(@Headers("authorization") authorization?: string) {
    return this.runAccountOrgIndexRebuild(authorization);
  }

  @Post("account-org-index-rebuild")
  @HttpCode(200)
  postAccountOrgIndexRebuild(@Headers("authorization") authorization?: string) {
    return this.runAccountOrgIndexRebuild(authorization);
  }

  @Get("org-purge-worker")
  getOrgPurgeWorker(@Headers("authorization") authorization?: string) {
    return this.runOrgPurgeWorker(authorization);
  }

  @Post("org-purge-worker")
  @HttpCode(200)
  postOrgPurgeWorker(@Headers("authorization") authorization?: string) {
    return this.runOrgPurgeWorker(authorization);
  }

  @Get("idempotency-fence-sweep")
  getIdempotencyFenceSweep(@Headers("authorization") authorization?: string) {
    return this.runIdempotencyFenceSweep(authorization);
  }

  @Post("idempotency-fence-sweep")
  @HttpCode(200)
  postIdempotencyFenceSweep(@Headers("authorization") authorization?: string) {
    return this.runIdempotencyFenceSweep(authorization);
  }

  @Get("timesheets-exception-detection")
  getTimesheetsExceptionDetection(
    @Headers("authorization") authorization?: string,
  ) {
    return this.runTimesheetsExceptionDetection(authorization);
  }

  @Post("timesheets-exception-detection")
  @HttpCode(200)
  postTimesheetsExceptionDetection(
    @Headers("authorization") authorization?: string,
  ) {
    return this.runTimesheetsExceptionDetection(authorization);
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

  private async runNotificationTimeSweeps(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("notification-time-sweeps", 300, () =>
        Promise.all([this.crmFollowupSweep.sweep(), this.timeSweeps.sweep()]),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "notification-time-sweeps already running" };
      const [crm, general] = outcome.result;
      return {
        success: true,
        message:
          `Follow-ups ${crm.due} due / ${crm.overdue} overdue; ` +
          `${general.slaBreached} SLA, ${general.invoicesDueSoon} invoice, ` +
          `${general.envelopesExpiring} envelope, ${general.eventsStartingSoon} calendar`,
        ...crm,
        ...general,
      };
    } catch (error) {
      logger.error("Notification time sweeps cron failed", error);
      throw new InternalServerErrorException("Internal server error");
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

  private async runNotificationDigestFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("notification-digest-flush", 120, () =>
        this.digest.flushDue(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "notification-digest-flush already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Flushed ${result.windows} digest window(s): ${result.itemsFlushed} item(s), ${result.notificationsCreated} notification(s)`,
        ...result,
      };
    } catch (error) {
      logger.error("Notification digest flush cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runNotificationOutboxFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("notification-outbox-flush", 120, () =>
        this.outboxRelay.flush(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "notification-outbox-flush already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Claimed ${result.claimed}: ${result.processed} processed, ${result.retried} retrying, ${result.dead} dead`,
        ...result,
      };
    } catch (error) {
      logger.error("Notification outbox flush cron failed", error);
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

  private async runNotificationsRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("notifications-retention-sweep", 300, () =>
        this.notificationRetention.sweep(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "notifications-retention-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message:
          `Purged ${result.emailBodiesPurged} email bodies and ${result.deliveryBodiesPurged} delivery bodies; ` +
          `deleted ${result.emailRecordsDeleted} email rows and ${result.deliveryRecordsDeleted} delivery rows`,
        ...result,
      };
    } catch (error) {
      logger.error("Notification retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runNotificationsRetentionDetach(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.partitionRetention.sweep();
      if (result === null) {
        return { success: true, skipped: true, message: "notification-retention-detach already running" };
      }
      return {
        success: true,
        message: `Detached ${result.partitionsDetached} partitions and dropped ${result.partitionsDropped}`,
        ...result,
      };
    } catch (error) {
      logger.error("Notification retention detach cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runChatReplyReminders(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("chat-reply-reminders", 120, () =>
        this.chatReplyReminders.processDueReminders(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "chat-reply-reminders already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Sent ${result.sent} chat reply reminders, cancelled ${result.cancelled}`,
        ...result,
      };
    } catch (error) {
      logger.error("Chat reply reminder cron failed", error);
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

  private async runNotificationDeliveryFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("notification-delivery-flush", 120, () =>
        this.notificationDelivery.flush(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "notification-delivery-flush already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Processed ${result.processed} deliveries: ${result.sent} sent, ${result.failed} retrying, ${result.dead} dead`,
        ...result,
      };
    } catch (error) {
      logger.error("Notification delivery flush cron failed", error);
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
