import { and, asc, eq, gte, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { calendarEventExceptions } from "../../db/schema";
import type { CalendarEventException } from "./calendar-occurrence.service";
import { CALENDAR_EVENTS_CAP } from "./dto/calendar.schemas";

/**
 * Upper bound on exceptions fetched in one pass.
 *
 * Each recurring event can produce O(1) user-authored exceptions per window.
 * With at most CALENDAR_EVENTS_CAP recurring events and a 2-month window,
 * 5 × CALENDAR_EVENTS_CAP gives generous headroom without a data-scaling loop.
 */
const EXCEPTION_SINGLE_PASS_CAP = CALENDAR_EVENTS_CAP * 5;

export interface RescheduledOccurrence {
  title: string;
  startDate: Date;
  endDate: Date;
  nominalStartMs: number;
}

export function collectRescheduledOccurrences(
  event: { title: string; startDate: Date; endDate: Date },
  exceptions: readonly CalendarEventException[],
  windowStart: Date,
  windowEnd: Date,
): RescheduledOccurrence[] {
  const duration = event.endDate.getTime() - event.startDate.getTime();
  const winStartMs = windowStart.getTime();
  const winEndMs = windowEnd.getTime();
  const results: RescheduledOccurrence[] = [];
  for (const ex of exceptions) {
    if (ex.isCancelled || !ex.modifiedStart) continue;
    const modMs = ex.modifiedStart.getTime();
    if (modMs < winStartMs || modMs >= winEndMs) continue;
    const nominalMs = ex.occurrenceStart.getTime();
    if (nominalMs >= winStartMs && nominalMs < winEndMs) continue;
    const endDate = ex.modifiedEnd ?? new Date(ex.modifiedStart.getTime() + duration);
    results.push({
      title: ex.modifiedTitle ?? event.title,
      startDate: ex.modifiedStart,
      endDate,
      nominalStartMs: nominalMs,
    });
  }
  return results;
}

/**
 * The exceptions a window can possibly need.
 *
 * An occurrence is expanded from its NOMINAL instant, so an exception is only ever
 * consulted when that instant falls inside the window; the second arm additionally keeps
 * an exception that MOVED an occurrence into the window, which `collectRescheduledOccurrences`
 * needs. Everything outside both arms is loaded for nothing.
 *
 * Exported so `CalendarConflictService` bounds its own load by exactly the same rule
 * rather than restating it — it was loading every exception the tenant had ever written,
 * with no window predicate and no limit, inside the create-event write transaction.
 */
export function exceptionsInWindow(windowStart: Date, windowEnd: Date) {
  return or(
    and(
      gte(calendarEventExceptions.occurrenceStart, windowStart),
      lt(calendarEventExceptions.occurrenceStart, windowEnd),
    ),
    and(
      isNotNull(calendarEventExceptions.modifiedStart),
      gte(calendarEventExceptions.modifiedStart, windowStart),
      lt(calendarEventExceptions.modifiedStart, windowEnd),
    ),
  );
}

/**
 * Single-pass exception fetch for the given recurring event IDs and window.
 *
 * The previous implementation looped in pages of 500. Since recurring events
 * are capped at CALENDAR_EVENTS_CAP and each produces O(1) user-authored
 * exceptions per window, EXCEPTION_SINGLE_PASS_CAP covers any realistic
 * workload without a data-scaling loop, reducing the statement count from
 * O(exceptions / 500) to exactly 1.
 */
export async function loadExceptionsByEvent(
  db: Db,
  orgId: string,
  recurringEventIds: number[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<number, CalendarEventException[]>> {
  const byEvent = new Map<number, CalendarEventException[]>();
  if (recurringEventIds.length === 0) return byEvent;

  const rows = await db
    .select({
      eventId: calendarEventExceptions.eventId,
      occurrenceStart: calendarEventExceptions.occurrenceStart,
      isCancelled: calendarEventExceptions.isCancelled,
      modifiedTitle: calendarEventExceptions.modifiedTitle,
      modifiedStart: calendarEventExceptions.modifiedStart,
      modifiedEnd: calendarEventExceptions.modifiedEnd,
    })
    .from(calendarEventExceptions)
    .where(
      and(
        eq(calendarEventExceptions.orgId, orgId),
        inArray(calendarEventExceptions.eventId, recurringEventIds),
        exceptionsInWindow(windowStart, windowEnd),
      ),
    )
    .orderBy(asc(calendarEventExceptions.eventId))
    .limit(EXCEPTION_SINGLE_PASS_CAP);

  for (const ex of rows) {
    const list = byEvent.get(ex.eventId) ?? [];
    list.push({
      occurrenceStart: ex.occurrenceStart,
      isCancelled: ex.isCancelled,
      modifiedTitle: ex.modifiedTitle,
      modifiedStart: ex.modifiedStart,
      modifiedEnd: ex.modifiedEnd,
    });
    byEvent.set(ex.eventId, list);
  }

  return byEvent;
}
