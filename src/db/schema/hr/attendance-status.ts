export const ATTENDANCE_RECORD_STATUSES = [
  "PRESENT",
  "ON_BREAK",
  "CHECKED_OUT",
  "ABSENT",
  "HALF_DAY",
  "LATE",
  "WFH",
  "HALFDAY",
  "HOLIDAY_WORK",
  "LEAVE_WITHOUT_PAY",
] as const;

export type AttendanceRecordStatus =
  (typeof ATTENDANCE_RECORD_STATUSES)[number];
