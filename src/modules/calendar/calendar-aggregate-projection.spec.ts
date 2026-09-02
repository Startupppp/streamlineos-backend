import type { Db } from "../../db/drizzle.module";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import type { CalendarSourceRegistry } from "./calendar-source.registry";
import type { CalendarEventProjection } from "./calendar-event-source";
import type { LinkedTicket } from "./calendar.types";

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

function makeProjection(linkedTicket: unknown): CalendarEventProjection {
  return {
    id: "evt-1",
    title: "Test Event",
    start: new Date("2024-06-01T10:00:00Z"),
    end: new Date("2024-06-01T11:00:00Z"),
    allDay: false,
    category: "general",
    meta: { linkedTicket },
  };
}

const START = new Date("2024-06-01T00:00:00Z");
const END = new Date("2024-06-30T23:59:59Z");

describe("CalendarEventsAggregateService — linkedTicket type guard", () => {
  it("returns null when linkedTicket is a plain object missing required fields", async () => {
    const svc = makeService([makeProjection({ notId: "bad" })]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]?.linkedTicket).toBeNull();
  });

  it("returns null when linkedTicket has wrong field types (id as string)", async () => {
    const svc = makeService([makeProjection({ id: "not-a-number", key: "T-1", title: "X", projectId: 1, status: "open" })]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]?.linkedTicket).toBeNull();
  });

  it("returns null when linkedTicket is null", async () => {
    const svc = makeService([makeProjection(null)]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]?.linkedTicket).toBeNull();
  });

  it("returns null when linkedTicket is a primitive string", async () => {
    const svc = makeService([makeProjection("not-an-object")]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]?.linkedTicket).toBeNull();
  });

  it("returns the LinkedTicket object when the meta value is well-formed", async () => {
    const ticket: LinkedTicket = { id: 42, key: "BUILD-1", title: "Fix bug", projectId: 7, status: "open" };
    const svc = makeService([makeProjection(ticket)]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]?.linkedTicket).toEqual(ticket);
  });

  it("returns the LinkedTicket object when projectId is 0 (falsy number boundary)", async () => {
    const ticket: LinkedTicket = { id: 1, key: "B-2", title: "Zero project", projectId: 0, status: "done" };
    const svc = makeService([makeProjection(ticket)]);
    const { events } = await svc.getEvents("org-1", "user-1", START, END);
    expect(events[0]?.linkedTicket).toEqual(ticket);
  });
});
