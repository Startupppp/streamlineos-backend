import { and, asc, eq, gte, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { calendarEventExceptions } from "../../db/schema";
import { MAX_OCCURRENCES_PER_WINDOW, type CalendarEventException } from "./calendar-occurrence.service";
import { drainByKeysetBounded } from "./calendar-keyset-drain";

const EXCEPTION_PAGE_SIZE = 20_000;
const EXCEPTION_PER_EVENT_CEILING = MAX_OCCURRENCES_PER_WINDOW;

export interface LoadedExceptions {
  byEvent: Map<number, CalendarEventException[]>;
  complete: boolean;
}

interface ExceptionPageRow {
  id: number;
  eventId: number;
  occurrenceStart: Date;
  isCancelled: boolean;
  modifiedTitle: string | null;
  modifiedStart: Date | null;
  modifiedEnd: Date | null;
}

function afterEventCursor(after: ExceptionPageRow | undefined): SQL | undefined {
  if (!after) return undefined;
  return sql`(${calendarEventExceptions.eventId}, ${calendarEventExceptions.id}) > (${after.eventId}, ${after.id})`;
}

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

export async function loadExceptionsByEvent(
  db: Db,
  orgId: string,
  recurringEventIds: number[],
  windowStart: Date,
  windowEnd: Date,
): Promise<LoadedExceptions> {
  const byEvent = new Map<number, CalendarEventException[]>();
  if (recurringEventIds.length === 0) return { byEvent, complete: true };

  const { rows, complete } = await drainByKeysetBounded<ExceptionPageRow>(
    EXCEPTION_PAGE_SIZE,
    recurringEventIds.length * EXCEPTION_PER_EVENT_CEILING,
    (take, after) =>
      db
        .select({
          id: calendarEventExceptions.id,
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
            afterEventCursor(after),
          ),
        )
        .orderBy(asc(calendarEventExceptions.eventId), asc(calendarEventExceptions.id))
        .limit(take),
  );

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

  return { byEvent, complete };
}
