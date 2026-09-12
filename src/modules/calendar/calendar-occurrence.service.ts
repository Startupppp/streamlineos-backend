import { RRule } from "rrule";
import { toWallClockUtc, fromWallClockUtc } from "../../common/date/zoned-wall-clock";


export interface CalendarEventLike {
  id: number;
  title: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timezone: string;
  orgId: string;
  rrule?: string | null;
  recurrenceEnd?: Date | null;
}

export interface CalendarOccurrence {
  eventId: number;
  title: string;
  startDate: Date;
  endDate: Date;
  /**
   * The instant the RRULE generated, before any exception moved it — equal to
   * `startDate` unless this occurrence carries a `modifiedStart`.
   *
   * This is the occurrence's identity, and `calendar_event_exceptions.occurrence_start`
   * is keyed on it. `startDate` is where the occurrence currently sits and therefore
   * changes every time it is moved; anything that has to NAME the occurrence — the
   * projection id, the exception key — has to use this instead, or the name changes
   * with the thing it names. For a non-recurring event the two are the same value.
   */
  nominalStart: Date;
  allDay: boolean;
  timezone: string;
  orgId: string;
}

export interface CalendarEventException {
  occurrenceStart: Date;
  isCancelled: boolean;
  modifiedTitle?: string | null;
  modifiedStart?: Date | null;
  modifiedEnd?: Date | null;
}

export const MAX_OCCURRENCES_PER_WINDOW = 500;

export function occurrencesWereTruncated(occurrences: readonly CalendarOccurrence[]): boolean {
  return occurrences.length >= MAX_OCCURRENCES_PER_WINDOW;
}

/**
 * `rrule` reads a `dtstart`'s UTC getters as the wall clock, so an expansion in
 * a named zone must hand it a Date whose UTC fields ARE that zone's wall clock.
 * That conversion is shared — `common/date/zoned-wall-clock` — because the cron
 * scheduler needs exactly the same thing and had exactly the same defect.
 */
export { toWallClockUtc, fromWallClockUtc };

export function eventOverlapsWindow(
  startDate: Date,
  endDate: Date,
  allDay: boolean,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  if (allDay) {
    const evStart = startDate.toISOString().slice(0, 10);
    const evEnd = endDate.toISOString().slice(0, 10);
    const winStart = windowStart.toISOString().slice(0, 10);
    const winEnd = windowEnd.toISOString().slice(0, 10);
    return evStart < winEnd && evEnd > winStart;
  }
  return startDate < windowEnd && endDate > windowStart;
}

function expandRecurring(
  event: CalendarEventLike,
  windowStart: Date,
  windowEnd: Date,
  exceptions: readonly CalendarEventException[],
): CalendarOccurrence[] {
  const rruleStr = event.rrule;
  if (!rruleStr) return [];

  const rule = RRule.fromString(rruleStr);
  const duration = event.endDate.getTime() - event.startDate.getTime();

  const localDtstart = toWallClockUtc(event.startDate, event.timezone);
  const localWindowStart = toWallClockUtc(windowStart, event.timezone);
  const localWindowEnd = toWallClockUtc(windowEnd, event.timezone);

  const localUntil = rule.origOptions.until
    ? toWallClockUtc(rule.origOptions.until, event.timezone)
    : rule.origOptions.until;

  const expandedRule = new RRule({
    ...rule.origOptions,
    dtstart: localDtstart,
    until: localUntil,
  });

  const localDates = expandedRule.between(localWindowStart, localWindowEnd, true);
  const seriesEnd = event.recurrenceEnd ? event.recurrenceEnd.getTime() : null;

  const exceptionMap = new Map<number, CalendarEventException>();
  for (const ex of exceptions) {
    exceptionMap.set(ex.occurrenceStart.getTime(), ex);
  }

  const results: CalendarOccurrence[] = [];
  for (const localDate of localDates) {
    if (results.length >= MAX_OCCURRENCES_PER_WINDOW) break;

    const utcStart = fromWallClockUtc(localDate, event.timezone);
    if (seriesEnd !== null && utcStart.getTime() > seriesEnd) break;
    const ex = exceptionMap.get(utcStart.getTime());

    if (ex?.isCancelled) continue;

    const effectiveStart = ex?.modifiedStart ?? utcStart;
    const nominalEnd = new Date(utcStart.getTime() + duration);
    const effectiveEnd = ex?.modifiedEnd ?? (ex?.modifiedStart ? new Date(ex.modifiedStart.getTime() + duration) : nominalEnd);
    results.push({
      eventId: event.id,
      title: ex?.modifiedTitle ?? event.title,
      startDate: effectiveStart,
      nominalStart: utcStart,
      endDate: effectiveEnd,
      allDay: event.allDay,
      timezone: event.timezone,
      orgId: event.orgId,
    });
  }
  return results;
}

export function expandToOccurrences(
  event: CalendarEventLike,
  windowStart: Date,
  windowEnd: Date,
  exceptions: readonly CalendarEventException[] = [],
): CalendarOccurrence[] {
  if (event.rrule) {
    return expandRecurring(event, windowStart, windowEnd, exceptions);
  }

  if (!eventOverlapsWindow(event.startDate, event.endDate, event.allDay, windowStart, windowEnd)) {
    return [];
  }
  return [
    {
      eventId: event.id,
      title: event.title,
      startDate: event.startDate,
      nominalStart: event.startDate,
      endDate: event.endDate,
      allDay: event.allDay,
      timezone: event.timezone,
      orgId: event.orgId,
    },
  ];
}
