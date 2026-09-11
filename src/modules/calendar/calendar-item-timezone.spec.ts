import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import type { Db } from "../../db/drizzle.module";
import type { CalendarEventProjection } from "./calendar-event-source";

const CALENDAR_DIR = __dirname;

function projection(meta: Record<string, unknown>): CalendarEventProjection {
  return {
    id: "event-1",
    title: "Standup",
    start: new Date("2027-03-10T03:30:00.000Z"),
    end: new Date("2027-03-10T04:00:00.000Z"),
    allDay: false,
    color: null,
    category: "meeting",
    meta,
  } as CalendarEventProjection;
}

function makeService(projections: CalendarEventProjection[]) {
  const registry = {
    loadAll: jest.fn().mockResolvedValue({
      events: projections,
      toggleList: [{ key: "native", label: "Events" }],
      failures: [],
      truncatedKeys: [],
    }),
  } as unknown as CalendarSourceRegistry;
  return new CalendarEventsAggregateService({} as unknown as Db, registry);
}

describe("CalendarEventItem carries the authored timezone", () => {
  it("projects meta.timezone onto the item the API returns", async () => {
    const service = makeService([projection({ source: "event", timezone: "Asia/Kolkata" })]);

    const result = await service.getEvents("org-1", "user-1", new Date(0), new Date(1));

    expect(result.events[0]?.timezone).toBe("Asia/Kolkata");
  });

  it("BITE: a source with no authored zone reports null rather than silently inheriting the reader's", async () => {
    const service = makeService([projection({ source: "holiday" })]);

    const result = await service.getEvents("org-1", "user-1", new Date(0), new Date(1));

    expect(result.events[0]?.timezone).toBeNull();
  });

  it("BITE: a non-string zone is rejected, not passed through as a label", async () => {
    const service = makeService([projection({ source: "event", timezone: 530 })]);

    const result = await service.getEvents("org-1", "user-1", new Date(0), new Date(1));

    expect(result.events[0]?.timezone).toBeNull();
  });

  it("the native source is what puts the zone in meta — both the plain and the rescheduled branch", () => {
    const source = readFileSync(join(CALENDAR_DIR, "calendar-native-event-source.ts"), "utf-8");
    const occurrences = source.split('source: "event",');

    expect(occurrences).toHaveLength(3);
    for (const branch of occurrences.slice(1))
      expect(branch.slice(0, 120)).toContain("timezone: event.timezone");
  });

  it("the expansion the zone drives is unchanged: occurrences are still computed in the event's zone", () => {
    const occurrence = readFileSync(join(CALENDAR_DIR, "calendar-occurrence.service.ts"), "utf-8");

    expect(occurrence).toContain("toWallClockUtc(event.startDate, event.timezone)");
    expect(occurrence).toContain("fromWallClockUtc(localDate, event.timezone)");
  });
});
