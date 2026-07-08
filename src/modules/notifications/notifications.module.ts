import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationEventService } from "./notification-event.service";
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
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationRoutingService } from "./notification-routing.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { NotificationDeliveryWorker } from "./notification-delivery-worker.service";
import { NotificationEmailProvider } from "./providers/notification-email.provider";
import { NotificationProviderRegistry } from "./providers/notification-provider-registry.service";
import { NotificationProvidersService } from "./notification-providers.service";
import { NotificationProvidersController } from "./notification-providers.controller";
import { NotificationEventsController } from "./notification-events.controller";
import { NotificationPolicyService } from "./notification-policy.service";
import { NotificationPolicyController } from "./notification-policy.controller";

@Module({
  controllers: [
    NotificationsController,
    NotificationTemplatesController,
    BroadcastsController,
    NotificationAnalyticsController,
    NotificationPreferencesController,
    NotificationQueueController,
    NotificationProvidersController,
    NotificationEventsController,
    NotificationPolicyController,
  ],
  providers: [
    NotificationsService,
    NotificationEventService,
    NotificationTemplatesService,
    BroadcastsService,
    NotificationAnalyticsService,
    NotificationPreferencesService,
    NotificationQueueService,
    NotificationEventRegistryService,
    NotificationRoutingService,
    NotificationDispatchService,
    NotificationDeliveryWorker,
    NotificationEmailProvider,
    NotificationProviderRegistry,
    NotificationProvidersService,
    NotificationPolicyService,
  ],
  exports: [
    NotificationsService,
    NotificationEventService,
    NotificationDispatchService,
    NotificationEventRegistryService,
    NotificationDeliveryWorker,
  ],
})
export class NotificationsModule {}
