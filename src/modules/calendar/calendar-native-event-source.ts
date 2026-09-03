import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { CalendarEventSourceLoader } from "./calendar-event-source.loader";
import { collectRescheduledOccurrences } from "./calendar-exception-loader";
import { expandToOccurrences } from "./calendar-occurrence.service";
import { CALENDAR_EVENTS_CAP } from "./dto/calendar.schemas";
import type {
  CalendarEventProjection,
  CalendarEventSource,
  CalendarSourceContext,
} from "./calendar-event-source";

@Injectable()
export class CalendarNativeEventSource implements CalendarEventSource, OnModuleInit {
  readonly key = "calendar-events";
  readonly label = "Calendar events";
  readonly module = "calendar";

  private readonly loader: CalendarEventSourceLoader;

  constructor(
    @Inject(DRIZZLE) db: Db,
    private readonly registry: CalendarSourceRegistry,
  ) {
    this.loader = new CalendarEventSourceLoader(db);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async load(ctx: CalendarSourceContext): Promise<CalendarEventProjection[]> {
    const { eventsData, linkedTicketMap, exceptionsByEvent } = await this.loader.load(
      ctx.orgId,
      ctx.userId,
      ctx.start,
      ctx.end,
    );

    const projections: CalendarEventProjection[] = [];

    for (const event of eventsData) {
      if (projections.length >= CALENDAR_EVENTS_CAP) break;

      const exceptions = exceptionsByEvent.get(event.id) ?? [];
      const occurrences = expandToOccurrences(
        {
          id: event.id,
          title: event.title,
          startDate: event.startDate,
          endDate: event.endDate,
          allDay: event.allDay,
          timezone: event.timezone,
          orgId: ctx.orgId,
          rrule: event.rrule,
          recurrenceEnd: event.recurrenceEnd,
        },
        ctx.start,
        ctx.end,
        exceptions,
      );

      const isRecurring = event.rrule !== null;

      for (const occ of occurrences) {
        if (projections.length >= CALENDAR_EVENTS_CAP) break;
        projections.push({
          id: isRecurring ? `event-${event.id}-${occ.startDate.toISOString()}` : `event-${event.id}`,
          title: occ.title,
          start: occ.startDate,
          end: occ.endDate,
          allDay: event.allDay,
          color: event.color,
          category: event.category,
          meta: {
            source: "event",
            timezone: event.timezone,
            location: event.location,
            meetingUrl: event.meetingUrl,
            description: event.description,
            creatorName: event.creatorName ?? null,
            entityId: event.entityId,
            entityType: event.entityType,
            myRsvpStatus: event.rsvpStatus ?? null,
            rrule: event.rrule,
            isRecurring,
            linkedTicket:
              event.entityType === "ticket" && event.entityId
                ? linkedTicketMap.get(Number(event.entityId)) ?? null
                : null,
          },
        });
      }

      if (isRecurring) {
        const rescheduled = collectRescheduledOccurrences(event, exceptions, ctx.start, ctx.end);
        for (const rs of rescheduled) {
          if (projections.length >= CALENDAR_EVENTS_CAP) break;
          projections.push({
            id: `event-${event.id}-${new Date(rs.nominalStartMs).toISOString()}`,
            title: rs.title,
            start: rs.startDate,
            end: rs.endDate,
            allDay: event.allDay,
            color: event.color,
            category: event.category,
            meta: {
              source: "event",
              timezone: event.timezone,
              location: event.location,
              meetingUrl: event.meetingUrl,
              description: event.description,
              creatorName: event.creatorName ?? null,
              entityId: event.entityId,
              entityType: event.entityType,
              myRsvpStatus: event.rsvpStatus ?? null,
              rrule: event.rrule,
              isRecurring,
              linkedTicket:
                event.entityType === "ticket" && event.entityId
                  ? linkedTicketMap.get(Number(event.entityId)) ?? null
                  : null,
            },
          });
        }
      }
    }

    return projections;
  }
}
