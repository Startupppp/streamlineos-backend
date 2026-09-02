import { and, asc, eq, gt, gte, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { calendarEventExceptions } from "../../db/schema";
import type { CalendarEventException } from "./calendar-occurrence.service";

const EXCEPTION_PAGE_SIZE = 500;

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

export async function loadExceptionsByEvent(
  db: Db,
  orgId: string,
  recurringEventIds: number[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<number, CalendarEventException[]>> {
  const byEvent = new Map<number, CalendarEventException[]>();
  if (recurringEventIds.length === 0) return byEvent;

  let afterId = 0;
  for (;;) {
    const page = await db
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
          or(
            and(
              gte(calendarEventExceptions.occurrenceStart, windowStart),
              lt(calendarEventExceptions.occurrenceStart, windowEnd),
            ),
            and(
              isNotNull(calendarEventExceptions.modifiedStart),
              gte(calendarEventExceptions.modifiedStart, windowStart),
              lt(calendarEventExceptions.modifiedStart, windowEnd),
            ),
          ),
          gt(calendarEventExceptions.id, afterId),
        ),
      )
      .orderBy(asc(calendarEventExceptions.id))
      .limit(EXCEPTION_PAGE_SIZE);

    if (page.length === 0) break;

    for (const ex of page) {
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

    const last = page[page.length - 1];
    if (!last) break;
    afterId = last.id;
    if (page.length < EXCEPTION_PAGE_SIZE) break;
  }

  return byEvent;
}
