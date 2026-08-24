import { Module } from "@nestjs/common";
import { CalendarModule } from "../calendar/calendar.module";
import { BuildCalendarSource } from "./build-calendar-source";

@Module({
  imports: [CalendarModule],
  providers: [BuildCalendarSource],
})
export class BuildCalendarModule {}
