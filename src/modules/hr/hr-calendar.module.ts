import { Module } from "@nestjs/common";
import { CalendarModule } from "../calendar/calendar.module";
import { AttendancePolicyModule } from "./time/attendance-policy.module";
import { HrCalendarSource } from "./hr-calendar-source";
import {
  HrAttendanceCalendarSource,
  HrHolidayCalendarSource,
  HrInterviewCalendarSource,
  HrLeaveCalendarSource,
} from "./hr-calendar-sources";

@Module({
  imports: [CalendarModule, AttendancePolicyModule],
  providers: [
    HrCalendarSource,
    HrLeaveCalendarSource,
    HrInterviewCalendarSource,
    HrAttendanceCalendarSource,
    HrHolidayCalendarSource,
  ],
})
export class HrCalendarModule {}
