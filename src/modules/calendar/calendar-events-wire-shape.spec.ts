import type { Db } from "../../db/drizzle.module";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { CalendarNativeEventSource } from "./calendar-native-event-source";
import type { CalendarSourceRegistry } from "./calendar-source.registry";
import type { CalendarEventProjection } from "./calendar-event-source";
import { CalendarEventSourceLoader, type VisibleEventRow } from "./calendar-event-source.loader";
import { calendarEventsResponseSchema } from "./dto/calendar-response.schemas";

const ORG = "org-1";
const USER = "user-1";
const START = new Date("2026-06-01T00:00:00Z");
const END = new Date("2026-06-30T23:59:59Z");

function visibleRow(over: Partial<VisibleEventRow> = {}): VisibleEventRow {
  return {
    id: 1,
    title: "Standup",
    description: null,
    location: null,
    meetingUrl: null,
    startDate: new Date("2026-06-02T09:00:00Z"),
    endDate: new Date("2026-06-02T09:15:00Z"),
    allDay: false,
    timezone: "Asia/Kolkata",
    color: "blue",
    category: "general",
    entityType: null,
    entityId: null,
    visibility: "org",
    rrule: null,
    recurrenceEnd: null,
    createdByMembershipId: 11,
    creatorName: "Ada Lovelace",
    rsvpStatus: null,
    ...over,
  };
}

function nativeSourceOver(rows: VisibleEventRow[]): CalendarNativeEventSource {
  const registry = { register: jest.fn() } as unknown as CalendarSourceRegistry;
  const source = new CalendarNativeEventSource({} as unknown as Db, registry);
  const loader: Pick<CalendarEventSourceLoader, "load"> = {
    load: jest.fn().mockResolvedValue({
      eventsData: rows,
      linkedTicketMap: new Map(),
      exceptionsByEvent: new Map(),
    }),
  };
  Reflect.set(source, "loader", loader);
  return source;
}

function aggregateOver(projections: CalendarEventProjection[]): CalendarEventsAggregateService {
  const registry = {
    loadAll: jest.fn().mockResolvedValue({
      events: projections,
      toggleList: [],
      failures: [],
      truncatedKeys: [],
    }),
  } as unknown as CalendarSourceRegistry;
  return new CalendarEventsAggregateService({} as unknown as Db, registry);
}

async function readEvents(rows: VisibleEventRow[]) {
  const projections = await nativeSourceOver(rows).load({
    orgId: ORG,
    userId: USER,
    start: START,
    end: END,
    scope: "all",
  });
  return aggregateOver(projections).getEvents(ORG, USER, START, END);
}

describe("GET /calendar/events — the shape the read path returns", () => {
  it("satisfies the schema its @ResponseSchema declares", async () => {
    const result = await readEvents([visibleRow()]);
    const parsed = calendarEventsResponseSchema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("native events carry none of the four opaque detail-only fields in the range response", async () => {
    const { events } = await readEvents([
      visibleRow({ rrule: "FREQ=WEEKLY;COUNT=2", description: "long desc", meetingUrl: "https://meet.example.com/x" }),
    ]);
    expect(events.length).toBeGreaterThan(0);
    const ev = events[0];
    expect(ev).not.toHaveProperty("rrule");
    expect(ev).not.toHaveProperty("isRecurring");
    expect(ev).not.toHaveProperty("meetingUrl");
    expect(ev).not.toHaveProperty("linkedTicket");
  });

  it("native events have description and creatorName as null in the range (text stripped, key retained for non-native)", async () => {
    const { events } = await readEvents([
      visibleRow({ description: "should not appear in range", creatorName: "Alice" }),
    ]);
    expect(events.length).toBeGreaterThan(0);
    const ev = events[0];
    expect(ev?.description).toBeNull();
    expect(ev?.creatorName).toBeNull();
  });

  it("recurring and one-off native events both satisfy the compact schema", async () => {
    const recurring = await readEvents([visibleRow({ rrule: "FREQ=WEEKLY;COUNT=2" })]);
    const oneOff = await readEvents([visibleRow({ rrule: null })]);
    expect(calendarEventsResponseSchema.safeParse(recurring).success).toBe(true);
    expect(calendarEventsResponseSchema.safeParse(oneOff).success).toBe(true);
  });

  it("keeps start and end as Date instances, which is what the contract declares", async () => {
    const { events } = await readEvents([visibleRow()]);
    expect(events[0]?.start).toBeInstanceOf(Date);
    expect(events[0]?.end).toBeInstanceOf(Date);
  });

  it("non-native sources still emit description and creatorName from their meta", async () => {
    const result = await aggregateOver([
      {
        id: "leave-9",
        title: "Annual leave",
        start: START,
        end: END,
        allDay: true,
        category: "leave",
        meta: { source: "leave", description: "Medical", creatorName: "Alice" },
      },
    ]).getEvents(ORG, USER, START, END);
    expect(result.events[0]?.description).toBe("Medical");
    expect(result.events[0]?.creatorName).toBe("Alice");
    expect(calendarEventsResponseSchema.safeParse(result).success).toBe(true);
  });

  it("reports a failed source by key and label rather than failing the whole read", async () => {
    const registry = {
      loadAll: jest.fn().mockResolvedValue({
        events: [],
        toggleList: [{ key: "hr-leaves", label: "Leave", module: "hr", enabled: true }],
        failures: [{ key: "hr-leaves", error: new Error("down") }],
        truncatedKeys: [],
      }),
    } as unknown as CalendarSourceRegistry;
    const result = await new CalendarEventsAggregateService(
      {} as unknown as Db,
      registry,
    ).getEvents(ORG, USER, START, END);
    expect(result.failures).toEqual([{ key: "hr-leaves", label: "Leave" }]);
    expect(calendarEventsResponseSchema.safeParse(result).success).toBe(true);
  });
});
