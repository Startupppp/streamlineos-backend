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
import { CalendarAttendeesService } from "./calendar-attendees.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";

@Module({
  imports: [IntegrationsModule, NotificationsModule],
  controllers: [CalendarController, CalendarAdminSettingsController],
  providers: [
    CalendarEventsAggregateService,
    CalendarAttendeesService,
    CalendarRecurrenceService,
    CalendarExportService,
    CalendarService,
    CalendarConflictService,
    CalendarReminderSweepService,
    ExternalCalendarEventsService,
    ExternalCalendarSyncService,
    CalendarSourceRegistry,
    CalendarSourcePreferencesService,
    CalendarNativeEventSource,
  ],
  exports: [CalendarService, CalendarConflictService, CalendarReminderSweepService, CalendarSourceRegistry],
})
export class CalendarModule {}
