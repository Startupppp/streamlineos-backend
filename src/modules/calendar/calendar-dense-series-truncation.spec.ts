import { Test } from "@nestjs/testing";
import { CalendarNativeEventSource } from "./calendar-native-event-source";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { CalendarSourcePreferencesService } from "./calendar-source-preferences.service";
import { AccessService } from "../access/access.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import {
  MAX_OCCURRENCES_PER_WINDOW,
  expandToOccurrences,
  occurrencesWereTruncated,
} from "./calendar-occurrence.service";
import type { Db } from "../../db/drizzle.module";
import type {
  CalendarEventProjection,
  CalendarEventSource,
  CalendarSourceContext,
} from "./calendar-event-source";

const ORG = "org-dense-series";
const USER = "user-dense-series";
const WIN_START = new Date("2026-09-01T00:00:00.000Z");
const WIN_END = new Date("2026-12-30T00:00:00.000Z");

const ctx: CalendarSourceContext = { orgId: ORG, userId: USER, start: WIN_START, end: WIN_END };

const HOURLY = "FREQ=HOURLY";
const WEEKLY = "FREQ=WEEKLY;BYDAY=MO";

function eventRow(overrides: { id?: number; rrule?: string | null }) {
  return {
    id: overrides.id ?? 1,
    title: "Dense series",
    description: null,
    location: null,
    meetingUrl: null,
    startDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-01T00:30:00.000Z"),
    allDay: false,
    timezone: "UTC",
    color: null,
    category: "work",
    entityType: null,
    entityId: null,
    visibility: "org",
    rrule: overrides.rrule ?? null,
    recurrenceEnd: null,
    createdByMembershipId: 1,
    creatorName: null,
    rsvpStatus: null,
  };
}

type ChainNode = Promise<unknown[]> & Record<string, unknown>;

function chain(rows: unknown[]): ChainNode {
  const node = Promise.resolve(rows) as ChainNode;
  for (const key of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"])
    node[key] = jest.fn(() => node);
  return node;
}

function exceptionRows(count: number, eventId: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    eventId,
    occurrenceStart: new Date(WIN_START.getTime() + i * 3_600_000),
    isCancelled: false,
    modifiedTitle: null,
    modifiedStart: null,
    modifiedEnd: null,
  }));
}

function makeDb(events: ReturnType<typeof eventRow>[], exceptions: unknown[] = []): Db {
  let candidateCall = 0;
  return {
    query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
    select: jest.fn().mockImplementation((fields: Record<string, unknown> | undefined) => {
      const keys = Object.keys(fields ?? {});
      const has = (k: string) => keys.includes(k);
      if (has("startDate") && keys.length === 2) {
        candidateCall++;
        return chain(candidateCall === 1 ? [] : events.map((e) => ({ id: e.id, startDate: e.startDate })));
      }
      if (has("eventId") && has("status")) return chain([]);
      if (has("membershipId") && has("name")) return chain([]);
      if (has("title") && has("rrule")) return chain(events);
      return chain(exceptions);
    }),
  } as unknown as Db;
}

function makeSource(db: Db): CalendarNativeEventSource {
  const registry = { register: jest.fn() } as unknown as CalendarSourceRegistry;
  return new CalendarNativeEventSource(db, registry);
}

async function buildAggregate(source: CalendarEventSource): Promise<CalendarEventsAggregateService> {
  const module = await Test.createTestingModule({
    providers: [
      CalendarSourceRegistry,
      CalendarEventsAggregateService,
      { provide: DRIZZLE, useValue: {} },
      {
        provide: AccessService,
        useValue: { moduleAvailabilityFor: jest.fn().mockResolvedValue({ available: true }) },
      },
      {
        provide: CalendarSourcePreferencesService,
        useValue: { getDisabledKeys: jest.fn().mockResolvedValue(new Set<string>()) },
      },
    ],
  }).compile();
  module.get(CalendarSourceRegistry).register(source);
  return module.get(CalendarEventsAggregateService);
}

function stubSource(events: CalendarEventProjection[], truncated: boolean): CalendarEventSource {
  return {
    key: "calendar-events",
    label: "Calendar events",
    module: "calendar",
    load: jest.fn().mockResolvedValue({ events, truncated }),
  };
}

describe("dense series occurrence cap — CA2", () => {
  it("expandToOccurrences stops at MAX_OCCURRENCES_PER_WINDOW for an hourly series", () => {
    const occurrences = expandToOccurrences(
      {
        id: 1,
        title: "Dense series",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-01T00:30:00.000Z"),
        allDay: false,
        timezone: "UTC",
        orgId: ORG,
        rrule: HOURLY,
      },
      WIN_START,
      WIN_END,
      [],
    );

    expect(occurrences).toHaveLength(MAX_OCCURRENCES_PER_WINDOW);
    expect(occurrencesWereTruncated(occurrences)).toBe(true);
  });

  it("occurrencesWereTruncated is false for a series the window renders whole", () => {
    const occurrences = expandToOccurrences(
      {
        id: 1,
        title: "Weekly",
        startDate: new Date("2026-09-07T09:00:00.000Z"),
        endDate: new Date("2026-09-07T09:30:00.000Z"),
        allDay: false,
        timezone: "UTC",
        orgId: ORG,
        rrule: WEEKLY,
      },
      WIN_START,
      WIN_END,
      [],
    );

    expect(occurrences.length).toBeLessThan(MAX_OCCURRENCES_PER_WINDOW);
    expect(occurrencesWereTruncated(occurrences)).toBe(false);
  });

  it("the native source REPORTS the dense-series cut instead of returning a capped list as whole", async () => {
    const db = makeDb([eventRow({ rrule: HOURLY })]);

    const result = await makeSource(db).load(ctx);

    expect(result.truncated).toBe(true);
    expect(result.events.length).toBe(MAX_OCCURRENCES_PER_WINDOW);
  });

  it("the native source reports truncated:false for a sparse series, so the flag is not always on", async () => {
    const db = makeDb([eventRow({ rrule: WEEKLY })]);

    const result = await makeSource(db).load(ctx);

    expect(result.truncated).toBe(false);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("an incomplete exception load also raises the source's truncation flag", async () => {
    const db = makeDb([eventRow({ id: 1, rrule: WEEKLY })], exceptionRows(600, 1));

    const result = await makeSource(db).load(ctx);

    expect(result.truncated).toBe(true);
  });

  it("getEvents carries a source's truncation flag even when the merged set is under every row cap", async () => {
    const one: CalendarEventProjection = {
      id: "event-1",
      title: "Dense series",
      start: WIN_START,
      end: new Date(WIN_START.getTime() + 1_800_000),
      allDay: false,
      category: "work",
      meta: { source: "event" },
    };
    const aggregate = await buildAggregate(stubSource([one], true));

    const result = await aggregate.getEvents(ORG, USER, WIN_START, WIN_END);

    expect(result.events).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("BITE: the same single-event response reports truncated:false when the source says it is whole", async () => {
    const one: CalendarEventProjection = {
      id: "event-1",
      title: "Weekly",
      start: WIN_START,
      end: new Date(WIN_START.getTime() + 1_800_000),
      allDay: false,
      category: "work",
      meta: { source: "event" },
    };
    const aggregate = await buildAggregate(stubSource([one], false));

    const result = await aggregate.getEvents(ORG, USER, WIN_START, WIN_END);

    expect(result.truncated).toBe(false);
  });
});
