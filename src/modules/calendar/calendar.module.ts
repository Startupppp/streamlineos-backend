import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { CalendarService } from "./calendar.service";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { ExternalCalendarEventsService } from "./external-calendar-events.service";
import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { CalendarSourcePreferencesService } from "./calendar-source-preferences.service";
import { IntegrationsModule } from "../integrations/core/integrations.module";
import { CalendarNativeEventSource } from "./calendar-native-event-source";
import { CalendarConflictService } from "./calendar-conflict.service";

@Module({
  imports: [IntegrationsModule],
  controllers: [CalendarController],
  providers: [
    CalendarEventsAggregateService,
    CalendarService,
    CalendarConflictService,
    ExternalCalendarEventsService,
    ExternalCalendarSyncService,
    CalendarSourceRegistry,
    CalendarSourcePreferencesService,
    CalendarNativeEventSource,
  ],
  exports: [CalendarService, CalendarConflictService, CalendarSourceRegistry],
})
export class CalendarModule {}
