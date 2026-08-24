import { Module } from "@nestjs/common";
import { CalendarModule } from "../calendar/calendar.module";
import { AttendancePolicyModule } from "./time/attendance-policy.module";
import { HrCalendarSource } from "./hr-calendar-source";

@Module({
  imports: [CalendarModule, AttendancePolicyModule],
  providers: [HrCalendarSource],
})
export class HrCalendarModule {}
