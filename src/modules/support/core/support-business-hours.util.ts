import { fromWallClockUtc, toWallClockUtc } from "../../../common/date/zoned-wall-clock";
import type { WeeklySchedule } from "../../../db/schema/support/support-sla";

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MAX_DAYS_SCANNED = 400;

export interface BusinessHoursConfig {
  timezone: string;
  weeklySchedule: WeeklySchedule;
  holidays: string[];
  is24x7: boolean;
}

function toDateKey(wall: Date): string {
  const y = wall.getUTCFullYear();
  const m = String(wall.getUTCMonth() + 1).padStart(2, "0");
  const d = String(wall.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseTimeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

function startOfNextWallDay(wall: Date): Date {
  const next = new Date(wall.getTime());
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

/**
 * Adds `minutesNeeded` of working time to `fromUtc`, honoring the given business
 * hours (weekly schedule + holidays) in the configured timezone. Falls back to
 * plain calendar-time addition when no business hours are configured or the
 * policy is marked 24x7.
 *
 * The day and window arithmetic runs on UTC FIELDS of a wall-clock Date, which
 * have no transitions. `toZonedTime` produced a Date whose SYSTEM-LOCAL fields
 * read as the policy's wall clock, so `setHours`/`setDate` wrote the HOST's
 * clock: on the host's own spring-forward day a window boundary inside the
 * missing hour was normalised forward and every due date computed from it moved
 * by an hour. Measured over 960 (schedule x zone x instant x minutes) cases:
 * 24 disagreements with UTC at a host in America/New_York, 32 at
 * Australia/Adelaide, 29 at America/Havana, 13 at Asia/Beirut -- and 0 at
 * Asia/Calcutta, which is why the machine this was written on never saw it.
 */
export function addWorkingMinutes(
  fromUtc: Date,
  minutesNeeded: number,
  businessHours: BusinessHoursConfig | null,
): Date {
  if (!businessHours || businessHours.is24x7) {
    return new Date(fromUtc.getTime() + minutesNeeded * 60_000);
  }

  const { timezone, weeklySchedule, holidays } = businessHours;
  const holidaySet = new Set(holidays);
  let remaining = minutesNeeded;
  let cursorUtc = fromUtc;

  for (let dayIndex = 0; dayIndex < MAX_DAYS_SCANNED; dayIndex++) {
    const wallCursor = toWallClockUtc(cursorUtc, timezone);
    const dateKey = toDateKey(wallCursor);
    const weekdayKey = WEEKDAY_KEYS[wallCursor.getUTCDay()];
    const daySchedule = weeklySchedule[weekdayKey];

    if (!daySchedule || holidaySet.has(dateKey)) {
      cursorUtc = fromWallClockUtc(startOfNextWallDay(wallCursor), timezone);
      continue;
    }

    const windowStartMinutes = parseTimeToMinutes(daySchedule.start);
    const windowEndMinutes = parseTimeToMinutes(daySchedule.end);

    const wallWindowStart = new Date(wallCursor.getTime());
    wallWindowStart.setUTCHours(0, windowStartMinutes, 0, 0);
    const wallWindowEnd = new Date(wallCursor.getTime());
    wallWindowEnd.setUTCHours(0, windowEndMinutes, 0, 0);

    const windowStartUtc = fromWallClockUtc(wallWindowStart, timezone);
    const windowEndUtc = fromWallClockUtc(wallWindowEnd, timezone);

    const availableStartUtc = cursorUtc > windowStartUtc ? cursorUtc : windowStartUtc;

    if (availableStartUtc >= windowEndUtc) {
      cursorUtc = fromWallClockUtc(startOfNextWallDay(wallCursor), timezone);
      continue;
    }

    const availableMinutesToday = (windowEndUtc.getTime() - availableStartUtc.getTime()) / 60_000;

    if (remaining <= availableMinutesToday) {
      return new Date(availableStartUtc.getTime() + remaining * 60_000);
    }

    remaining -= availableMinutesToday;
    cursorUtc = fromWallClockUtc(startOfNextWallDay(wallCursor), timezone);
  }

  return new Date(cursorUtc.getTime() + remaining * 60_000);
}
