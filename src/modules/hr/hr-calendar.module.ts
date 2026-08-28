import { Module } from "@nestjs/common";
import { CalendarModule } from "../calendar/calendar.module";
import { AttendancePolicyModule } from "./time/attendance-policy.module";
import { HrCalendarSource } from "./hr-calendar-source";
import { DirectoryModule } from "../directory/directory.module";
import {
  HrAttendanceCalendarSource,
  HrHolidayCalendarSource,
  HrInterviewCalendarSource,
  HrLeaveCalendarSource,
} from "./hr-calendar-sources";

@Module({
  imports: [CalendarModule, AttendancePolicyModule, DirectoryModule],
  providers: [
    HrCalendarSource,
    HrLeaveCalendarSource,
    HrInterviewCalendarSource,
    HrAttendanceCalendarSource,
    HrHolidayCalendarSource,
  ],
})
export class HrCalendarModule {}
