import type { Db } from "../../db/drizzle.module";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { CalendarNativeEventSource } from "./calendar-native-event-source";
import type { CalendarSourceRegistry } from "./calendar-source.registry";
import type { CalendarEventProjection } from "./calendar-event-source";
import { CalendarEventSourceLoader, type VisibleEventRow } from "./calendar-event-source.loader";
import { calendarEventsResponseSchema } from "./dto/calendar-response.schemas";

/**
 * `GET /calendar/events`, asserted on what the read path RETURNS.
 *
 * `hooks/api/calendar.ts:201` reads this route through
 * `apiClient.get<CalendarEventsResponse>(...)`, a CAST. Its `CalendarListItem` has
 * always declared `rrule` and `isRecurring`, and two features read them —
 * `features/calendar/event-detail-sheet.tsx:147` gates the "Cancel occurrence" button
 * on `event?.isRecurring`, and `features/calendar/use-event-create-dialog.ts:225` gates
 * the series-scope prompt on `event?.rrule`. The aggregate never emitted either:
 * `CalendarNativeEventSource.load` computes `isRecurring` on the line above the
 * projection and discarded it, and `projectionToItem` had no case for `rrule`. Both
 * fields were therefore permanently `undefined`, both features permanently
 * unreachable, and both repositories typechecked clean throughout, because the client's
 * type is hand-written and both fields are optional. Same defect class as the
 * always-empty Favourites section and the huddle tiles reading "Unknown".
 *
 * Nothing here relies on a type. Every assertion drives the real
 * `CalendarNativeEventSource` and the real `CalendarEventsAggregateService` over a
 * loader double that answers in the row shape `queryVisibleEvents` actually produces,
 * and checks the returned value against the same schema `@ResponseSchema` declares on
 * the controller — so the contract, the projection and the client's two reads are
 * pinned to one another rather than each to its own opinion.
 */

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

/** The real native source, with only the loader's database round trip replaced. */
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

  it("sends rrule and isRecurring for a recurring event — the two fields the client reads", async () => {
    const { events } = await readEvents([
      visibleRow({ rrule: "FREQ=WEEKLY;COUNT=2", recurrenceEnd: null }),
    ]);
    expect(events.length).toBeGreaterThan(0);
    // `event-detail-sheet.tsx:147` gates the Cancel-occurrence button on exactly this.
    expect(events[0]?.isRecurring).toBe(true);
    // `use-event-create-dialog.ts:225` gates the series-scope prompt on exactly this.
    expect(events[0]?.rrule).toBe("FREQ=WEEKLY;COUNT=2");
  });

  it("sends isRecurring false and rrule null for a one-off event", async () => {
    const { events } = await readEvents([visibleRow({ rrule: null })]);
    expect(events[0]?.isRecurring).toBe(false);
    expect(events[0]?.rrule).toBeNull();
  });

  it("still answers null for a source that has no recurrence concept at all", async () => {
    // A leave/holiday projection carries no `rrule` in its meta; the item must still be
    // contract-shaped rather than carrying `undefined` through as a missing key.
    const result = await aggregateOver([
      {
        id: "leave-9",
        title: "Annual leave",
        start: START,
        end: END,
        allDay: true,
        category: "leave",
        meta: { source: "leave" },
      },
    ]).getEvents(ORG, USER, START, END);
    expect(result.events[0]?.rrule).toBeNull();
    expect(result.events[0]?.isRecurring).toBe(false);
    expect(calendarEventsResponseSchema.safeParse(result).success).toBe(true);
  });

  it("keeps start and end as Date instances, which is what the contract declares", async () => {
    // The contract uses `wireDate()`, which accepts a Date and publishes
    // string/date-time. A service that pre-serialised here would fail this parse.
    const { events } = await readEvents([visibleRow()]);
    expect(events[0]?.start).toBeInstanceOf(Date);
    expect(events[0]?.end).toBeInstanceOf(Date);
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
