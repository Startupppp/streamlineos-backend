export interface CalendarEventLike {
  id: number;
  title: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timezone: string;
  orgId: string;
}

export interface CalendarOccurrence {
  eventId: number;
  title: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timezone: string;
  orgId: string;
}

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

export function expandToOccurrences(
  event: CalendarEventLike,
  windowStart: Date,
  windowEnd: Date,
): CalendarOccurrence[] {
  if (!eventOverlapsWindow(event.startDate, event.endDate, event.allDay, windowStart, windowEnd)) {
    return [];
  }
  return [
    {
      eventId: event.id,
      title: event.title,
      startDate: event.startDate,
      endDate: event.endDate,
      allDay: event.allDay,
      timezone: event.timezone,
      orgId: event.orgId,
    },
  ];
}
