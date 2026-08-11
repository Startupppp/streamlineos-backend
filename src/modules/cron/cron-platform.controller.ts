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
import { NotificationOutboxRelayService } from "../notifications/notification-outbox-relay.service";
import { CronOrganizationService } from "./cron-organization.service";
import { OwnershipTransfersService } from "../ownership/ownership-transfers.service";
import { CronOrgPurgeWorkerService } from "./cron-org-purge-worker.service";
import { CronIdempotencyService } from "./cron-idempotency.service";
import { ChatReplyRemindersService } from "../chat/chat-reply-reminders.service";
import { ExceptionsDetectorService } from "../timesheets/core/exceptions-detector.service";

@Public()
@Controller("cron")
export class CronPlatformController {
  constructor(
    private readonly chatReplyReminders: ChatReplyRemindersService,
    private readonly emailOutbox: CronEmailOutboxService,
    private readonly notificationDelivery: CronNotificationDeliveryService,
    private readonly cronOrganization: CronOrganizationService,
    private readonly ownershipTransfers: OwnershipTransfersService,
    private readonly orgPurgeWorker: CronOrgPurgeWorkerService,
    private readonly timesheetExceptionsDetector: ExceptionsDetectorService,
    private readonly idempotency: CronIdempotencyService,
    private readonly notificationRetention: CronNotificationRetentionService,
    private readonly outboxRelay: NotificationOutboxRelayService,
  ) {}

  @Get("notification-outbox-flush")
  getNotificationOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationOutboxFlush(authorization);
  }

  @Post("notification-outbox-flush")
  @HttpCode(200)
  postNotificationOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationOutboxFlush(authorization);
  }

  private async runNotificationOutboxFlush(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.outboxRelay.flush();
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

  @Get("notifications-retention-sweep")
  getNotificationsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionSweep(authorization);
  }

  @Post("notifications-retention-sweep")
  @HttpCode(200)
  postNotificationsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionSweep(authorization);
  }

  private async runNotificationsRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.notificationRetention.sweep();
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

  private async runChatReplyReminders(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.chatReplyReminders.processDueReminders();
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
      const result = await this.emailOutbox.flushOutbox();
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
      const result = await this.notificationDelivery.flush();
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
      const result = await this.cronOrganization.expireStaleInvitations();
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
      const result = await this.ownershipTransfers.expireStaleTransfers();
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

  private async runOrgPurgeWorker(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const result = await this.orgPurgeWorker.run();
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
      const result = await this.idempotency.pruneExpiredFences();
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
      const result = await this.timesheetExceptionsDetector.detectAllOrgs();
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
