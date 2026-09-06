import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { CalendarAdminSettingsController } from "./calendar-admin-settings.controller";
import { CalendarService } from "./calendar.service";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { ExternalCalendarEventsService } from "./external-calendar-events.service";
import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { CalendarSourcePreferencesService } from "./calendar-source-preferences.service";
import { IntegrationsModule } from "../integrations/core/integrations.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { CalendarNativeEventSource } from "./calendar-native-event-source";
import { CalendarConflictService } from "./calendar-conflict.service";
import { CalendarReminderSweepService } from "./calendar-reminder-sweep.service";
import { CalendarProviderSyncSweepService } from "./calendar-provider-sync-sweep.service";
import { CalendarAttendeesService } from "./calendar-attendees.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";
import { CalendarEventDetailService } from "./calendar-event-detail.service";
import { CalendarSyncStatusService } from "./calendar-sync-status.service";
import { CalendarProviderWebhookService } from "./calendar-provider-webhook.service";
import { CalendarProviderWebhookController } from "./calendar-provider-webhook.controller";

@Module({
  imports: [IntegrationsModule, NotificationsModule],
  controllers: [
    CalendarController,
    CalendarAdminSettingsController,
    CalendarProviderWebhookController,
  ],
  providers: [
    CalendarEventsAggregateService,
    CalendarAttendeesService,
    CalendarRecurrenceService,
    CalendarExportService,
    CalendarSyncStatusService,
    CalendarProviderWebhookService,
    CalendarEventDetailService,
    CalendarService,
    CalendarConflictService,
    CalendarReminderSweepService,
    CalendarProviderSyncSweepService,
    ExternalCalendarEventsService,
    ExternalCalendarSyncService,
    CalendarSourceRegistry,
    CalendarSourcePreferencesService,
    CalendarNativeEventSource,
  ],
  // CalendarProviderSyncSweepService is exported for exactly one consumer: CronModule's
  // /cron/calendar-provider-sync-sweep route. Without the export the provider-sync queue
  // has no drain that a scheduler can reach, and every synced event stays PENDING for ever.
  exports: [
    CalendarService,
    CalendarReminderSweepService,
    CalendarProviderSyncSweepService,
    CalendarSourceRegistry,
  ],
})
export class CalendarModule {}
