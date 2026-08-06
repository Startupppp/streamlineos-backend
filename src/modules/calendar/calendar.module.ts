import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { CalendarService } from "./calendar.service";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { ExternalCalendarEventsService } from "./external-calendar-events.service";
import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { IntegrationsModule } from "../integrations/core/integrations.module";
import { AttendancePolicyModule } from "../hr/time/attendance-policy.module";

@Module({
  imports: [IntegrationsModule, AttendancePolicyModule],
  controllers: [CalendarController],
  providers: [CalendarEventsAggregateService, CalendarService, ExternalCalendarEventsService, ExternalCalendarSyncService],
  exports: [CalendarService],
})
export class CalendarModule {}
