import type { Db } from "../../db/drizzle.module";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import type { CalendarSourceRegistry } from "./calendar-source.registry";
import type { CalendarEventProjection } from "./calendar-event-source";

function makeService(projections: CalendarEventProjection[]): CalendarEventsAggregateService {
  const db = {} as unknown as Db;
  const registry = {
    loadAll: jest.fn().mockResolvedValue({
      events: projections,
      toggleList: [],
      failures: [],
      truncatedKeys: [],
    }),
  } as unknown as CalendarSourceRegistry;
  return new CalendarEventsAggregateService(db, registry);
}

function makeProjection(meta: Record<string, unknown> = {}): CalendarEventProjection {
  return {
    id: "evt-1",
    title: "Test Event",
    start: new Date("2024-06-01T10:00:00Z"),
    end: new Date("2024-06-01T11:00:00Z"),
    allDay: false,
    category: "general",
    meta,
  };
}

const START = new Date("2024-06-01T00:00:00Z");
const END = new Date("2024-06-30T23:59:59Z");

describe("CalendarEventsAggregateService — range projection", () => {
  it("does not include linkedTicket on range items (detail-only field)", async () => {
    const svc = makeService([
      makeProjection({ source: "event", linkedTicket: { id: 42, key: "B-1", title: "Fix", projectId: 7, status: "open" } }),
    ]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]).not.toHaveProperty("linkedTicket");
  });

  it("does not include meetingUrl on range items (detail-only field)", async () => {
    const svc = makeService([
      makeProjection({ source: "event", meetingUrl: "https://meet.example.com/x" }),
    ]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]).not.toHaveProperty("meetingUrl");
  });

  it("does not include rrule on range items (detail-only field)", async () => {
    const svc = makeService([
      makeProjection({ source: "event", rrule: "FREQ=WEEKLY;COUNT=4" }),
    ]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]).not.toHaveProperty("rrule");
  });

  it("does not include isRecurring on range items (detail-only field)", async () => {
    const svc = makeService([
      makeProjection({ source: "event", isRecurring: true }),
    ]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]).not.toHaveProperty("isRecurring");
  });

  it("passes description and creatorName from non-native meta through to the range item", async () => {
    const svc = makeService([
      makeProjection({ source: "leave", description: "Medical leave", creatorName: "Alice" }),
    ]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]?.description).toBe("Medical leave");
    expect(events[0]?.creatorName).toBe("Alice");
  });

  it("projects description as null when meta carries no string value (native source after strip)", async () => {
    const svc = makeService([
      makeProjection({ source: "event" }),
    ]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]?.description).toBeNull();
    expect(events[0]?.creatorName).toBeNull();
  });

  it("projects projectId from numeric meta values", async () => {
    const svc = makeService([
      makeProjection({ source: "task", projectId: 42 }),
    ]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]?.projectId).toBe(42);
  });
});
