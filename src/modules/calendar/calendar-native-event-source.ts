import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { CalendarEventSourceLoader } from "./calendar-event-source.loader";
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
    const { eventsData, linkedTicketMap } = await this.loader.load(
      ctx.orgId,
      ctx.userId,
      ctx.start,
      ctx.end,
    );

    return eventsData.map((event) => ({
      id: `event-${event.id}`,
      title: event.title,
      start: event.startDate,
      end: event.endDate,
      allDay: event.allDay ?? false,
      color: event.color,
      category: event.category,
      meta: {
        source: "event",
        location: event.location,
        meetingUrl: event.meetingUrl,
        description: event.description,
        creatorName: event.creatorName ?? null,
        entityId: event.entityId,
        entityType: event.entityType,
        myRsvpStatus: event.rsvpStatus ?? null,
        linkedTicket:
          event.entityType === "ticket" && event.entityId
            ? linkedTicketMap.get(Number(event.entityId)) ?? null
            : null,
      },
    }));
  }
}
