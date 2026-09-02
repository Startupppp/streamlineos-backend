import { Module } from "@nestjs/common";
import { MailModule } from "../mail/mail.module";
import { BuildApprovalsInboxModule } from "../build/approvals/build-approvals-inbox.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { UnifiedInboxService } from "./unified-inbox.service";
import { NotificationsReadService } from "./notifications-read.service";
import { NotificationsLifecycleService } from "./notifications-lifecycle.service";
import { NotificationEventService } from "./notification-event.service";
import { NotificationTemplatesController } from "./notification-templates.controller";
import { NotificationTemplatesService } from "./notification-templates.service";
import { BroadcastsController } from "./broadcasts.controller";
import { BroadcastsService } from "./broadcasts.service";
import { NotificationPreferencesController } from "./notification-preferences.controller";
import { NotificationPreferencesService } from "./notification-preferences.service";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationRoutingService } from "./notification-routing.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import { NotificationOutboxRelayService } from "./notification-outbox-relay.service";
import { NotificationTemplateRenderer } from "./notification-template-renderer.service";
import { NotificationPreferenceRulesService } from "./notification-preference-rules.service";
import { NotificationDigestService } from "./notification-digest.service";
import { NotificationDispatchPersistenceService } from "./notification-dispatch-persistence.service";
import { NotificationWhatsAppProvider } from "./providers/notification-whatsapp.provider";
import { NotificationSmsProvider } from "./providers/notification-sms.provider";
import { NotificationTimeSweepsService } from "./time-sweeps/notification-time-sweeps.service";
import { NotificationDeliveryWorker } from "./notification-delivery-worker.service";
import { NotificationEmailProvider } from "./providers/notification-email.provider";
import { NotificationWebPushProvider } from "./providers/notification-web-push.provider";
import { NotificationProviderRegistry } from "./providers/notification-provider-registry.service";
import { RealtimeModule } from "../realtime/realtime.module";
import { NotificationProvidersService } from "./notification-providers.service";
import { NotificationProvidersController } from "./notification-providers.controller";
import { NotificationEventsController } from "./notification-events.controller";
import { NotificationPolicyService } from "./notification-policy.service";
import { NotificationPolicyController } from "./notification-policy.controller";

@Module({
  imports: [RealtimeModule, MailModule, BuildApprovalsInboxModule],
  controllers: [
    NotificationsController,
    NotificationTemplatesController,
    BroadcastsController,
    NotificationPreferencesController,
    NotificationProvidersController,
    NotificationEventsController,
    NotificationPolicyController,
  ],
  providers: [
    NotificationsReadService,
    NotificationsLifecycleService,
    NotificationsService,
    NotificationEventService,
    NotificationTemplatesService,
    BroadcastsService,
    NotificationPreferencesService,
    NotificationEventRegistryService,
    NotificationRoutingService,
    NotificationDispatchService,
    NotificationDispatchPersistenceService,
    NotificationDeliveryWorker,
    NotificationEmailProvider,
    NotificationWebPushProvider,
    NotificationProviderRegistry,
    NotificationProvidersService,
    NotificationPolicyService,
    NotificationVisibilityRegistry,
    NotificationOutboxRelayService,
    NotificationTemplateRenderer,
    NotificationPreferenceRulesService,
    NotificationDigestService,
    NotificationWhatsAppProvider,
    NotificationSmsProvider,
    NotificationTimeSweepsService,
    UnifiedInboxService,
  ],
  exports: [
    NotificationsService,
    UnifiedInboxService,
    NotificationEventService,
    NotificationDispatchService,
    NotificationEventRegistryService,
    NotificationDeliveryWorker,
    NotificationVisibilityRegistry,
    NotificationOutboxRelayService,
    NotificationDigestService,
    NotificationTimeSweepsService,
  ],
})
export class NotificationsModule {}
