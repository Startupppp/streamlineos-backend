import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CalendarEventItem, CalendarEventsResult, LinkedTicket } from "./calendar.types";
import type { CalendarEventProjection, CalendarSourceContext } from "./calendar-event-source";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { CALENDAR_EVENTS_CAP } from "./dto/calendar.schemas";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isLinkedTicket(v: unknown): v is LinkedTicket {
  if (!isRecord(v)) return false;
  return (
    typeof v["id"] === "number" &&
    typeof v["key"] === "string" &&
    typeof v["title"] === "string" &&
    typeof v["projectId"] === "number" &&
    typeof v["status"] === "string"
  );
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
    myRsvpStatus: typeof p.meta["myRsvpStatus"] === "string" ? p.meta["myRsvpStatus"] : null,
    projectId: typeof p.meta["projectId"] === "number" ? p.meta["projectId"] : null,
    linkedTicket: isLinkedTicket(p.meta["linkedTicket"]) ? p.meta["linkedTicket"] : null,
  };
}

@Injectable()
export class CalendarEventsAggregateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: CalendarSourceRegistry,
  ) {}

  async getEvents(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEventsResult> {
    const ctx: CalendarSourceContext = { orgId, userId, start, end, scope: "all" };

    const { events: projections, toggleList, failures: rawFailures } =
      await this.registry.loadAll(ctx);

    const labelMap = new Map<string, string>(toggleList.map((t) => [t.key, t.label]));
    const failures = rawFailures.map(({ key }) => ({
      key,
      label: labelMap.get(key) ?? key,
    }));

    const result: CalendarEventItem[] = [];

    for (const projection of projections) result.push(projectionToItem(projection));

    const sorted = result.sort((a, b) => a.start.getTime() - b.start.getTime());
    const truncated = sorted.length > CALENDAR_EVENTS_CAP;
    return {
      events: truncated ? sorted.slice(0, CALENDAR_EVENTS_CAP) : sorted,
      failures,
      truncated,
    };
  }
}
