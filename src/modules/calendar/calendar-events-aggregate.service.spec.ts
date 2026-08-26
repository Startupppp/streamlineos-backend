jest.mock("../../db/compat/organization-holidays", () => ({
  listCompatibleHolidays: jest.fn().mockResolvedValue([]),
}));

import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { CalendarEventProjection } from "./calendar-event-source";
import { CALENDAR_EVENTS_CAP, CALENDAR_MAX_SPAN_DAYS, listEventsSchema } from "./dto/calendar.schemas";

function makeMinimalDb() {
  const terminal = { where: jest.fn().mockResolvedValue([]) };
  const afterFrom = {
    where: terminal.where,
    innerJoin: jest.fn().mockReturnValue(terminal),
  };
  return {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(afterFrom) }),
    query: {
      calendarEvents: { findMany: jest.fn().mockResolvedValue([]) },
    },
  };
}

function projection(id: string): CalendarEventProjection {
  return {
    id,
    title: "T",
    start: new Date("2026-08-01"),
    end: new Date("2026-08-02"),
    allDay: true,
    category: "leave",
    meta: { source: "leave" },
  };
}

describe("CalendarEventsAggregateService — partial failures", () => {
  it("returns events from the healthy source and a named failure for the broken one", async () => {
    const db = makeMinimalDb();
    const mockRegistry = {
      loadAll: jest.fn().mockResolvedValue({
        events: [projection("p1")],
        toggleList: [
          { key: "good", label: "Good Source", module: "hr", enabled: true },
          { key: "bad", label: "Bad Source", module: "build", enabled: true },
        ],
        failures: [{ key: "bad", error: new Error("database timeout") }],
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CalendarEventsAggregateService,
        { provide: DRIZZLE, useValue: db },
        { provide: CalendarSourceRegistry, useValue: mockRegistry },
      ],
    }).compile();

    const service = module.get(CalendarEventsAggregateService);
    const result = await service.getEvents("org-1", "user-1", new Date(), new Date());

    expect(result.events).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({ key: "bad", label: "Bad Source" });
  });

  it("never exposes the raw error — the failure entry carries only key and label", async () => {
    const db = makeMinimalDb();
    const mockRegistry = {
      loadAll: jest.fn().mockResolvedValue({
        events: [],
        toggleList: [{ key: "src", label: "Source", module: "hr", enabled: true }],
        failures: [{ key: "src", error: new Error("internal db secret") }],
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CalendarEventsAggregateService,
        { provide: DRIZZLE, useValue: db },
        { provide: CalendarSourceRegistry, useValue: mockRegistry },
      ],
    }).compile();

    const service = module.get(CalendarEventsAggregateService);
    const result = await service.getEvents("org-1", "user-1", new Date(), new Date());

    const failure = result.failures[0];
    expect(failure).toBeDefined();
    expect(Object.keys(failure ?? {})).toEqual(["key", "label"]);
    expect(JSON.stringify(failure)).not.toContain("internal db secret");
  });

  it("falls back to the key as label when the failure key is absent from the toggle list", async () => {
    const db = makeMinimalDb();
    const mockRegistry = {
      loadAll: jest.fn().mockResolvedValue({
        events: [],
        toggleList: [],
        failures: [{ key: "orphan-source", error: new Error("gone") }],
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CalendarEventsAggregateService,
        { provide: DRIZZLE, useValue: db },
        { provide: CalendarSourceRegistry, useValue: mockRegistry },
      ],
    }).compile();

    const service = module.get(CalendarEventsAggregateService);
    const result = await service.getEvents("org-1", "user-1", new Date(), new Date());

    expect(result.failures[0]).toEqual({ key: "orphan-source", label: "orphan-source" });
  });

  it("returns an empty failures array when all sources succeed", async () => {
    const db = makeMinimalDb();
    const mockRegistry = {
      loadAll: jest.fn().mockResolvedValue({
        events: [projection("p1")],
        toggleList: [{ key: "src", label: "Source", module: "hr", enabled: true }],
        failures: [],
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CalendarEventsAggregateService,
        { provide: DRIZZLE, useValue: db },
        { provide: CalendarSourceRegistry, useValue: mockRegistry },
      ],
    }).compile();

    const service = module.get(CalendarEventsAggregateService);
    const result = await service.getEvents("org-1", "user-1", new Date(), new Date());

    expect(result.failures).toHaveLength(0);
    expect(result.events).toHaveLength(1);
  });
});

describe("CalendarEventsAggregateService — event cap", () => {
  function manyProjections(count: number): CalendarEventProjection[] {
    return Array.from({ length: count }, (_, i) => projection(`p${i}`));
  }

  it("sets truncated:false when event count is at or below the cap", async () => {
    const db = makeMinimalDb();
    const mockRegistry = {
      loadAll: jest.fn().mockResolvedValue({
        events: manyProjections(CALENDAR_EVENTS_CAP),
        toggleList: [],
        failures: [],
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CalendarEventsAggregateService,
        { provide: DRIZZLE, useValue: db },
        { provide: CalendarSourceRegistry, useValue: mockRegistry },
      ],
    }).compile();

    const service = module.get(CalendarEventsAggregateService);
    const result = await service.getEvents("org-1", "user-1", new Date(), new Date());

    expect(result.truncated).toBe(false);
    expect(result.events.length).toBe(CALENDAR_EVENTS_CAP);
  });

  it("sets truncated:true and caps events at CALENDAR_EVENTS_CAP when exceeded", async () => {
    const db = makeMinimalDb();
    const over = CALENDAR_EVENTS_CAP + 50;
    const mockRegistry = {
      loadAll: jest.fn().mockResolvedValue({
        events: manyProjections(over),
        toggleList: [],
        failures: [],
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CalendarEventsAggregateService,
        { provide: DRIZZLE, useValue: db },
        { provide: CalendarSourceRegistry, useValue: mockRegistry },
      ],
    }).compile();

    const service = module.get(CalendarEventsAggregateService);
    const result = await service.getEvents("org-1", "user-1", new Date(), new Date());

    expect(result.truncated).toBe(true);
    expect(result.events.length).toBe(CALENDAR_EVENTS_CAP);
  });

  it("still surfaces source failures in the response when the cap is hit", async () => {
    const db = makeMinimalDb();
    const over = CALENDAR_EVENTS_CAP + 1;
    const mockRegistry = {
      loadAll: jest.fn().mockResolvedValue({
        events: manyProjections(over),
        toggleList: [{ key: "src", label: "Source", module: "hr", enabled: true }],
        failures: [{ key: "src", error: new Error("timeout") }],
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CalendarEventsAggregateService,
        { provide: DRIZZLE, useValue: db },
        { provide: CalendarSourceRegistry, useValue: mockRegistry },
      ],
    }).compile();

    const service = module.get(CalendarEventsAggregateService);
    const result = await service.getEvents("org-1", "user-1", new Date(), new Date());

    expect(result.truncated).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({ key: "src", label: "Source" });
  });
});

describe("listEventsSchema — date range enforcement", () => {
  it("rejects a non-date start", () => {
    const result = listEventsSchema.safeParse({ start: "not-a-date", end: "2026-08-01" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-date end", () => {
    const result = listEventsSchema.safeParse({ start: "2026-08-01", end: "bad" });
    expect(result.success).toBe(false);
  });

  it("rejects end before start", () => {
    const result = listEventsSchema.safeParse({
      start: "2026-08-10",
      end: "2026-08-01",
    });
    expect(result.success).toBe(false);
  });

  it("rejects end equal to start", () => {
    const result = listEventsSchema.safeParse({
      start: "2026-08-01",
      end: "2026-08-01",
    });
    expect(result.success).toBe(false);
  });

  it(`rejects a span exceeding ${CALENDAR_MAX_SPAN_DAYS} days`, () => {
    const start = new Date("2026-01-01");
    const end = new Date(start.getTime() + (CALENDAR_MAX_SPAN_DAYS + 1) * 24 * 60 * 60 * 1000);
    const result = listEventsSchema.safeParse({
      start: start.toISOString(),
      end: end.toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it(`accepts a span exactly at ${CALENDAR_MAX_SPAN_DAYS} days`, () => {
    const start = new Date("2026-01-01");
    const end = new Date(start.getTime() + CALENDAR_MAX_SPAN_DAYS * 24 * 60 * 60 * 1000);
    const result = listEventsSchema.safeParse({
      start: start.toISOString(),
      end: end.toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("accepts a typical frontend 3-month window (≤91 days)", () => {
    const result = listEventsSchema.safeParse({
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-09-30T23:59:59.999Z",
    });
    expect(result.success).toBe(true);
  });
});
