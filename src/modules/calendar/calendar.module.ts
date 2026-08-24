import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { CalendarService } from "./calendar.service";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { ExternalCalendarEventsService } from "./external-calendar-events.service";
import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { CalendarSourceRegistry, CALENDAR_SOURCE_TOKEN } from "./calendar-source.registry";
import { IntegrationsModule } from "../integrations/core/integrations.module";
import { AttendancePolicyModule } from "../hr/time/attendance-policy.module";
import { HrCalendarSource } from "../hr/hr-calendar-source";
import { BuildCalendarSource } from "../build/build-calendar-source";
import { TasksCalendarSource } from "../tasks/tasks-calendar-source";

@Module({
  imports: [IntegrationsModule, AttendancePolicyModule],
  controllers: [CalendarController],
  providers: [
    HrCalendarSource,
    BuildCalendarSource,
    TasksCalendarSource,
    {
      provide: CALENDAR_SOURCE_TOKEN,
      useFactory: (
        hr: HrCalendarSource,
        build: BuildCalendarSource,
        tasks: TasksCalendarSource,
      ) => [hr, build, tasks],
      inject: [HrCalendarSource, BuildCalendarSource, TasksCalendarSource],
    },
    CalendarEventsAggregateService,
    CalendarService,
    ExternalCalendarEventsService,
    ExternalCalendarSyncService,
    CalendarSourceRegistry,
  ],
  exports: [CalendarService, CalendarSourceRegistry],
})
export class CalendarModule {}
