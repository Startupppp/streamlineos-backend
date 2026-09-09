import type { ClockSegment } from "./lib/clock-segments";

export interface ClockRange {
  /** Inclusive `YYYY-MM-DD`. */
  start: string;
  /** Inclusive `YYYY-MM-DD`. */
  end: string;
}

/**
 * How timesheets asks what somebody's clock says.
 *
 * The port exists so that this module never reaches into HR's services. HRMS
 * is owned elsewhere and is read-only to this pack, so the dependency is stated
 * here as a contract that an adapter satisfies — and `check:timesheets-payroll-
 * boundary` fails the build if anything under `modules/timesheets` imports
 * `modules/hr` directly.
 *
 * An implementation returning an empty array is a legitimate answer, not an
 * error: an organisation may not track attendance at all. Callers must treat
 * "no segments" as "nothing to say", never as "no time worked".
 */
export interface TimesheetAttendancePort {
  getClockSegments(orgId: string, userId: string, range: ClockRange): Promise<ClockSegment[]>;
}

export const TIMESHEET_ATTENDANCE_PORT = Symbol("TimesheetAttendancePort");
