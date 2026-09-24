import type { ClockSegment } from "./lib/clock-segments";

export interface ClockRange {
  start: string;
  end: string;
}

export interface TimesheetAttendancePort {
  getClockSegments(orgId: string, userId: string, range: ClockRange): Promise<ClockSegment[]>;
}

export const TIMESHEET_ATTENDANCE_PORT = Symbol("TimesheetAttendancePort");
