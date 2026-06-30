import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationTemplatesController } from "./notification-templates.controller";
import { NotificationTemplatesService } from "./notification-templates.service";
import { BroadcastsController } from "./broadcasts.controller";
import { BroadcastsService } from "./broadcasts.service";
import { NotificationAnalyticsController } from "./notification-analytics.controller";
import { NotificationAnalyticsService } from "./notification-analytics.service";
import { NotificationPreferencesController } from "./notification-preferences.controller";
import { NotificationPreferencesService } from "./notification-preferences.service";
import { NotificationQueueController } from "./notification-queue.controller";
import { NotificationQueueService } from "./notification-queue.service";

@Module({
  controllers: [
    NotificationsController,
    NotificationTemplatesController,
    BroadcastsController,
    NotificationAnalyticsController,
    NotificationPreferencesController,
    NotificationQueueController,
  ],
  providers: [
    NotificationsService,
    NotificationTemplatesService,
    BroadcastsService,
    NotificationAnalyticsService,
    NotificationPreferencesService,
    NotificationQueueService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
