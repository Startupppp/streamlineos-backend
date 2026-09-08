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
import { CronNotificationRetentionService } from "./cron-notification-retention.service";
import { CronNotificationOutboxRetentionService } from "./cron-notification-outbox-retention.service";
import { NotificationRetentionService } from "../notifications/notification-retention.service";
import { CronLeaseService } from "./cron-lease.service";
import {
  notificationsRetentionSweepResponseSchema,
  notificationsRetentionDetachResponseSchema,
  notificationOutboxRetentionSweepResponseSchema,
} from "./dto/cron-notifications-response.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronNotificationRetentionController {
  constructor(
    private readonly notificationRetention: CronNotificationRetentionService,
    private readonly partitionRetention: NotificationRetentionService,
    private readonly notificationOutboxRetention: CronNotificationOutboxRetentionService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("notifications-retention-sweep")
  @ResponseSchema(notificationsRetentionSweepResponseSchema)
  getNotificationsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionSweep(authorization);
  }

  @Post("notifications-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(notificationsRetentionSweepResponseSchema)
  postNotificationsRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionSweep(authorization);
  }

  @Get("notifications-retention-detach")
  @ResponseSchema(notificationsRetentionDetachResponseSchema)
  getNotificationsRetentionDetach(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionDetach(authorization);
  }

  @Post("notifications-retention-detach")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(notificationsRetentionDetachResponseSchema)
  postNotificationsRetentionDetach(@Headers("authorization") authorization?: string) {
    return this.runNotificationsRetentionDetach(authorization);
  }

  @Get("notification-outbox-retention-sweep")
  @ResponseSchema(notificationOutboxRetentionSweepResponseSchema)
  getNotificationOutboxRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runNotificationOutboxRetentionSweep(authorization);
  }

  @Post("notification-outbox-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(notificationOutboxRetentionSweepResponseSchema)
  postNotificationOutboxRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runNotificationOutboxRetentionSweep(authorization);
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
      if (result === null)
        return { success: true, skipped: true, message: "notification-retention-detach already running" };
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

  private async runNotificationOutboxRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("notification-outbox-retention-sweep", 1800, () =>
        this.notificationOutboxRetention.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "notification-outbox-retention-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message:
          `Notification outbox retention: ${result.rowsDeleted} rows across ${result.organizationsScanned} orgs` +
          (result.truncated ? " (truncated — rerun)" : ""),
        ...result,
      };
    } catch (error) {
      logger.error("Notification outbox retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
