import { toZonedTime, fromZonedTime } from "date-fns-tz";
import type { WeeklySchedule } from "../../db/schema/support/support-sla";

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MAX_DAYS_SCANNED = 400;

export interface BusinessHoursConfig {
  timezone: string;
  weeklySchedule: WeeklySchedule;
  holidays: string[];
  is24x7: boolean;
}

function toDateKey(zoned: Date): string {
  const y = zoned.getFullYear();
  const m = String(zoned.getMonth() + 1).padStart(2, "0");
  const d = String(zoned.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseTimeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

function startOfNextZonedDay(zoned: Date): Date {
  const next = new Date(zoned);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

/**
 * Adds `minutesNeeded` of working time to `fromUtc`, honoring the given business
 * hours (weekly schedule + holidays) in the configured timezone. Falls back to
 * plain calendar-time addition when no business hours are configured or the
 * policy is marked 24x7.
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
    const zonedCursor = toZonedTime(cursorUtc, timezone);
    const dateKey = toDateKey(zonedCursor);
    const weekdayKey = WEEKDAY_KEYS[zonedCursor.getDay()];
    const daySchedule = weeklySchedule[weekdayKey];

    if (!daySchedule || holidaySet.has(dateKey)) {
      cursorUtc = fromZonedTime(startOfNextZonedDay(zonedCursor), timezone);
      continue;
    }

    const windowStartMinutes = parseTimeToMinutes(daySchedule.start);
    const windowEndMinutes = parseTimeToMinutes(daySchedule.end);

    const zonedWindowStart = new Date(zonedCursor);
    zonedWindowStart.setHours(0, windowStartMinutes, 0, 0);
    const zonedWindowEnd = new Date(zonedCursor);
    zonedWindowEnd.setHours(0, windowEndMinutes, 0, 0);

    const windowStartUtc = fromZonedTime(zonedWindowStart, timezone);
    const windowEndUtc = fromZonedTime(zonedWindowEnd, timezone);

    const availableStartUtc = cursorUtc > windowStartUtc ? cursorUtc : windowStartUtc;

    if (availableStartUtc >= windowEndUtc) {
      cursorUtc = fromZonedTime(startOfNextZonedDay(zonedCursor), timezone);
      continue;
    }

    const availableMinutesToday = (windowEndUtc.getTime() - availableStartUtc.getTime()) / 60_000;

    if (remaining <= availableMinutesToday) {
      return new Date(availableStartUtc.getTime() + remaining * 60_000);
    }

    remaining -= availableMinutesToday;
    cursorUtc = fromZonedTime(startOfNextZonedDay(zonedCursor), timezone);
  }

  return new Date(cursorUtc.getTime() + remaining * 60_000);
}
