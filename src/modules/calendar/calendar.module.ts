import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { CalendarService } from "./calendar.service";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { ExternalCalendarEventsService } from "./external-calendar-events.service";
import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { CalendarSourceRegistry, CALENDAR_SOURCE_TOKEN } from "./calendar-source.registry";
import type { CalendarEventSource } from "./calendar-event-source";
import { IntegrationsModule } from "../integrations/core/integrations.module";
import { AttendancePolicyModule } from "../hr/time/attendance-policy.module";

const emptySources: CalendarEventSource[] = [];

@Module({
  imports: [IntegrationsModule, AttendancePolicyModule],
  controllers: [CalendarController],
  providers: [
    { provide: CALENDAR_SOURCE_TOKEN, useValue: emptySources },
    CalendarEventsAggregateService,
    CalendarService,
    ExternalCalendarEventsService,
    ExternalCalendarSyncService,
    CalendarSourceRegistry,
  ],
  exports: [CalendarService, CalendarSourceRegistry],
})
export class CalendarModule {}
