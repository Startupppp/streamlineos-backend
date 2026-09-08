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
import { CronNotificationDeliveryService } from "./cron-notification-delivery.service";
import { NotificationOutboxRelayService } from "../notifications/notification-outbox-relay.service";
import { NotificationDigestService } from "../notifications/notification-digest.service";
import { CrmFollowupSweepService } from "../crm/core/crm-followup-sweep.service";
import { NotificationTimeSweepsService } from "../notifications/time-sweeps/notification-time-sweeps.service";
import { CronLeaseService } from "./cron-lease.service";
import {
  notificationTimeSweepsResponseSchema,
  notificationDigestFlushResponseSchema,
  notificationOutboxFlushResponseSchema,
  chatReplyRemindersResponseSchema,
  notificationDeliveryFlushResponseSchema,
} from "./dto/cron-notifications-response.schemas";
import { ChatReplyRemindersService } from "../chat/chat-reply-reminders.service";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronNotificationsController {
  constructor(
    private readonly chatReplyReminders: ChatReplyRemindersService,
    private readonly notificationDelivery: CronNotificationDeliveryService,
    private readonly outboxRelay: NotificationOutboxRelayService,
    private readonly digest: NotificationDigestService,
    private readonly crmFollowupSweep: CrmFollowupSweepService,
    private readonly timeSweeps: NotificationTimeSweepsService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("notification-time-sweeps")
  @ResponseSchema(notificationTimeSweepsResponseSchema)
  getNotificationTimeSweeps(@Headers("authorization") authorization?: string) {
    return this.runNotificationTimeSweeps(authorization);
  }

  @Post("notification-time-sweeps")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(notificationTimeSweepsResponseSchema)
  postNotificationTimeSweeps(@Headers("authorization") authorization?: string) {
    return this.runNotificationTimeSweeps(authorization);
  }

  @Get("notification-digest-flush")
  @ResponseSchema(notificationDigestFlushResponseSchema)
  getNotificationDigestFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationDigestFlush(authorization);
  }

  @Post("notification-digest-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(notificationDigestFlushResponseSchema)
  postNotificationDigestFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationDigestFlush(authorization);
  }

  @Get("notification-outbox-flush")
  @ResponseSchema(notificationOutboxFlushResponseSchema)
  getNotificationOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationOutboxFlush(authorization);
  }

  @Post("notification-outbox-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(notificationOutboxFlushResponseSchema)
  postNotificationOutboxFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationOutboxFlush(authorization);
  }

  @Get("chat-reply-reminders")
  @ResponseSchema(chatReplyRemindersResponseSchema)
  getChatReplyReminders(@Headers("authorization") authorization?: string) {
    return this.runChatReplyReminders(authorization);
  }

  @Post("chat-reply-reminders")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(chatReplyRemindersResponseSchema)
  postChatReplyReminders(@Headers("authorization") authorization?: string) {
    return this.runChatReplyReminders(authorization);
  }

  @Get("notification-delivery-flush")
  @ResponseSchema(notificationDeliveryFlushResponseSchema)
  getNotificationDeliveryFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationDeliveryFlush(authorization);
  }

  @Post("notification-delivery-flush")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(notificationDeliveryFlushResponseSchema)
  postNotificationDeliveryFlush(@Headers("authorization") authorization?: string) {
    return this.runNotificationDeliveryFlush(authorization);
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
}
