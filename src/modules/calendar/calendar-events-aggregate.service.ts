import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { listCompatibleHolidays } from "../../db/compat/organization-holidays";
import type { CalendarEventItem, LinkedTicket } from "./calendar.types";
import { dateOnly } from "./calendar.types";
import type { CalendarEventProjection, CalendarSourceContext } from "./calendar-event-source";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { CalendarEventSourceLoader } from "./calendar-event-source.loader";

function dateAtNoonUtc(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

function toItemSource(val: unknown): CalendarEventItem["source"] {
  if (
    val === "leave" ||
    val === "interview" ||
    val === "task" ||
    val === "holiday" ||
    val === "attendance"
  )
    return val;
  return "event";
}

function projectionToItem(p: CalendarEventProjection): CalendarEventItem {
  return {
    id: p.id,
    title: p.title,
    start: p.start,
    end: p.end,
    allDay: p.allDay,
    color: p.color,
    category: p.category,
    source: toItemSource(p.meta["source"]),
    location: typeof p.meta["location"] === "string" ? p.meta["location"] : null,
    meetingUrl: typeof p.meta["meetingUrl"] === "string" ? p.meta["meetingUrl"] : null,
    description: typeof p.meta["description"] === "string" ? p.meta["description"] : null,
    creatorName: typeof p.meta["creatorName"] === "string" ? p.meta["creatorName"] : null,
    entityId: typeof p.meta["entityId"] === "string" ? p.meta["entityId"] : null,
    entityType: typeof p.meta["entityType"] === "string" ? p.meta["entityType"] : null,
    myRsvpStatus: null,
    projectId: typeof p.meta["projectId"] === "number" ? p.meta["projectId"] : null,
    linkedTicket: null,
  };
}

@Injectable()
export class CalendarEventsAggregateService {
  private readonly nativeLoader: CalendarEventSourceLoader;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: CalendarSourceRegistry,
  ) {
    this.nativeLoader = new CalendarEventSourceLoader(db);
  }

  async getEvents(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEventItem[]> {
    const ctx: CalendarSourceContext = { orgId, userId, start, end, scope: "all" };

    const [{ eventsData, rsvpMap, linkedTicketMap }, holidaysData, { events: projections }] =
      await Promise.all([
        this.nativeLoader.load(orgId, userId, start, end),
        listCompatibleHolidays(this.db, orgId, dateOnly(start), dateOnly(end)),
        this.registry.loadAll(ctx),
      ]);

    const result: CalendarEventItem[] = [];

    for (const calendarEvent of eventsData) {
      let linkedTicket: LinkedTicket | null | undefined;
      if (calendarEvent.entityType === "ticket" && calendarEvent.entityId != null) {
        const id = parseInt(calendarEvent.entityId, 10);
        linkedTicket = Number.isNaN(id) ? null : (linkedTicketMap.get(id) ?? null);
      }
      result.push({
        id: `event-${calendarEvent.id}`,
        title: calendarEvent.title,
        start: calendarEvent.startDate,
        end: calendarEvent.endDate,
        allDay: calendarEvent.allDay ?? false,
        color: calendarEvent.color,
        category: calendarEvent.category,
        source: "event",
        location: calendarEvent.location,
        meetingUrl: calendarEvent.meetingUrl,
        description: calendarEvent.description,
        creatorName: calendarEvent.creator?.name ?? null,
        entityId: calendarEvent.entityId,
        entityType: calendarEvent.entityType,
        myRsvpStatus: rsvpMap.get(calendarEvent.id) ?? null,
        linkedTicket,
      });
    }

    for (const holiday of holidaysData) {
      const day = dateAtNoonUtc(holiday.date);
      result.push({
        id: `holiday-${holiday.id}`,
        title: holiday.name,
        start: day,
        end: day,
        allDay: true,
        color: "purple",
        category: "holiday",
        source: "holiday",
      });
    }

    for (const projection of projections) result.push(projectionToItem(projection));

    return result.sort((a, b) => a.start.getTime() - b.start.getTime());
  }
}
