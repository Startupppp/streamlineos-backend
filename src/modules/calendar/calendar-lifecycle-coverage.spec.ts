import { getTableConfig } from "drizzle-orm/pg-core";
import { eventAttendees } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { CalendarNativeEventSource } from "./calendar-native-event-source";
import { updateEventSchema } from "./dto/calendar.schemas";
import {
  expandToOccurrences,
  fromWallClockUtc,
  toWallClockUtc,
  type CalendarEventLike,
} from "./calendar-occurrence.service";

const ORG = "org-lifecycle-coverage";
const NY = "America/New_York";
const IST = "Asia/Kolkata";

function series(overrides: Partial<CalendarEventLike>): CalendarEventLike {
  return {
    id: 1,
    title: "Series",
    startDate: new Date("2024-03-04T07:30:00.000Z"),
    endDate: new Date("2024-03-04T08:00:00.000Z"),
    allDay: false,
    timezone: NY,
    orgId: ORG,
    rrule: null,
    recurrenceEnd: null,
    ...overrides,
  };
}

function localDay(instant: Date, timeZone: string): string {
  return toWallClockUtc(instant, timeZone).toISOString().slice(0, 10);
}

function localClock(instant: Date, timeZone: string): string {
  return toWallClockUtc(instant, timeZone).toISOString().slice(11, 16);
}

describe("DST spring-forward gap — a daily series must not lose the transition day", () => {
  const GAP_WALL_CLOCK = new Date(Date.UTC(2024, 2, 10, 2, 30, 0));

  it("resolves a wall clock inside the missing hour to a real, finite instant", () => {
    const resolved = fromWallClockUtc(GAP_WALL_CLOCK, NY);

    expect(Number.isFinite(resolved.getTime())).toBe(true);
    expect(Number.isNaN(resolved.getTime())).toBe(false);
  });

  it("resolves the missing wall clock deterministically, so two calls cannot disagree", () => {
    const first = fromWallClockUtc(GAP_WALL_CLOCK, NY);
    const second = fromWallClockUtc(GAP_WALL_CLOCK, NY);

    expect(first.getTime()).toBe(second.getTime());
  });

  it("emits one occurrence per local day across the transition, including the gap day itself", () => {
    const occurrences = expandToOccurrences(
      series({
        startDate: fromWallClockUtc(new Date(Date.UTC(2024, 2, 8, 2, 30, 0)), NY),
        endDate: fromWallClockUtc(new Date(Date.UTC(2024, 2, 8, 3, 0, 0)), NY),
        rrule: "FREQ=DAILY",
      }),
      new Date("2024-03-08T00:00:00.000Z"),
      new Date("2024-03-13T00:00:00.000Z"),
    );

    const days = occurrences.map((occ) => localDay(occ.startDate, NY));
    expect(days).toContain("2024-03-10");
    expect(new Set(days).size).toBe(days.length);
  });

  it("emits strictly increasing, distinct instants across the transition", () => {
    const occurrences = expandToOccurrences(
      series({
        startDate: fromWallClockUtc(new Date(Date.UTC(2024, 2, 8, 2, 30, 0)), NY),
        endDate: fromWallClockUtc(new Date(Date.UTC(2024, 2, 8, 3, 0, 0)), NY),
        rrule: "FREQ=DAILY",
      }),
      new Date("2024-03-08T00:00:00.000Z"),
      new Date("2024-03-13T00:00:00.000Z"),
    );

    const times = occurrences.map((occ) => occ.startDate.getTime());
    expect(times.length).toBeGreaterThan(2);
    for (let i = 1; i < times.length; i += 1)
      expect(times[i] ?? 0).toBeGreaterThan(times[i - 1] ?? 0);
  });
});

describe("occurrences that cross local midnight", () => {
  const START = fromWallClockUtc(new Date(Date.UTC(2026, 8, 7, 23, 0, 0)), IST);
  const END = fromWallClockUtc(new Date(Date.UTC(2026, 8, 8, 1, 0, 0)), IST);

  it("keeps the two-hour duration when an occurrence spans midnight in its own zone", () => {
    const occurrences = expandToOccurrences(
      series({ startDate: START, endDate: END, timezone: IST, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
    );

    expect(occurrences.length).toBeGreaterThan(1);
    for (const occ of occurrences)
      expect(occ.endDate.getTime() - occ.startDate.getTime()).toBe(2 * 60 * 60 * 1000);
  });

  it("starts every occurrence at 23:00 local and ends it on the FOLLOWING local day", () => {
    const occurrences = expandToOccurrences(
      series({ startDate: START, endDate: END, timezone: IST, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
    );

    for (const occ of occurrences) {
      expect(localClock(occ.startDate, IST)).toBe("23:00");
      expect(localDay(occ.endDate, IST)).not.toBe(localDay(occ.startDate, IST));
    }
  });
});

describe("RRULE COUNT bounds the series even inside a wide window", () => {
  it("emits exactly COUNT occurrences and stops", () => {
    const occurrences = expandToOccurrences(
      series({
        startDate: new Date("2026-09-07T09:00:00.000Z"),
        endDate: new Date("2026-09-07T09:30:00.000Z"),
        timezone: "UTC",
        rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      }),
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-12-30T00:00:00.000Z"),
    );

    expect(occurrences).toHaveLength(3);
  });

  it("BITE: the same series without COUNT fills the window", () => {
    const occurrences = expandToOccurrences(
      series({
        startDate: new Date("2026-09-07T09:00:00.000Z"),
        endDate: new Date("2026-09-07T09:30:00.000Z"),
        timezone: "UTC",
        rrule: "FREQ=WEEKLY;BYDAY=MO",
      }),
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-12-30T00:00:00.000Z"),
    );

    expect(occurrences.length).toBeGreaterThan(3);
  });
});

describe("all-day recurring series", () => {
  it("carries allDay onto every expanded occurrence", () => {
    const occurrences = expandToOccurrences(
      series({
        startDate: new Date("2026-09-07T00:00:00.000Z"),
        endDate: new Date("2026-09-08T00:00:00.000Z"),
        allDay: true,
        timezone: NY,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
      }),
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
    );

    expect(occurrences.length).toBeGreaterThan(1);
    for (const occ of occurrences) expect(occ.allDay).toBe(true);
  });

  it("keeps every all-day occurrence on the same local weekday", () => {
    const occurrences = expandToOccurrences(
      series({
        startDate: new Date("2026-09-07T00:00:00.000Z"),
        endDate: new Date("2026-09-08T00:00:00.000Z"),
        allDay: true,
        timezone: NY,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
      }),
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
    );

    const weekdays = new Set(
      occurrences.map((occ) => new Date(`${localDay(occ.startDate, NY)}T00:00:00.000Z`).getUTCDay()),
    );
    expect(weekdays.size).toBe(1);
  });
});

describe("updateEventSchema — an invalid range is rejected on the EDIT path too", () => {
  it("rejects a patch whose endDate precedes its startDate", () => {
    const parsed = updateEventSchema.safeParse({
      startDate: "2026-09-10T10:00:00.000Z",
      endDate: "2026-09-10T09:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("endDate");
  });

  it("rejects a patch whose endDate equals its startDate", () => {
    const parsed = updateEventSchema.safeParse({
      startDate: "2026-09-10T10:00:00.000Z",
      endDate: "2026-09-10T10:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a patch that moves both ends forward", () => {
    const parsed = updateEventSchema.safeParse({
      startDate: "2026-09-10T10:00:00.000Z",
      endDate: "2026-09-10T11:00:00.000Z",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts a patch that touches neither date, so ordinary field edits still pass", () => {
    const parsed = updateEventSchema.safeParse({ location: "Room 2" });

    expect(parsed.success).toBe(true);
  });
});

describe("two viewers of the same event see the same absolute instants", () => {
  const EVENT_START = new Date("2026-09-07T13:30:00.000Z");
  const EVENT_END = new Date("2026-09-07T14:00:00.000Z");

  function eventRow(timezone: string) {
    return {
      id: 77,
      title: "Cross-zone standup",
      description: null,
      location: null,
      meetingUrl: null,
      startDate: EVENT_START,
      endDate: EVENT_END,
      allDay: false,
      timezone,
      color: null,
      category: "meeting",
      entityType: null,
      entityId: null,
      visibility: "org",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      recurrenceEnd: null,
      createdByMembershipId: 1,
      creatorName: null,
      rsvpStatus: null,
    };
  }

  function chain(rows: unknown[]) {
    const node = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    for (const key of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"])
      node[key] = jest.fn(() => node);
    return node;
  }

  function db(timezone: string, membershipId: number): Db {
    let candidateCall = 0;
    const rows = [eventRow(timezone)];
    return {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: membershipId }) },
      },
      select: jest.fn().mockImplementation((fields: Record<string, unknown> | undefined) => {
        const keys = Object.keys(fields ?? {});
        const has = (k: string) => keys.includes(k);
        if (has("startDate") && keys.length === 2) {
          candidateCall++;
          return chain(candidateCall === 1 ? [] : rows.map((r) => ({ id: r.id, startDate: r.startDate })));
        }
        if (has("eventId") && has("status")) return chain([]);
        if (has("membershipId") && has("name")) return chain([]);
        if (has("title") && has("rrule")) return chain(rows);
        return chain([]);
      }),
    } as unknown as Db;
  }

  function source(database: Db): CalendarNativeEventSource {
    return new CalendarNativeEventSource(database, { register: jest.fn() } as never);
  }

  const WIN_START = new Date("2026-09-01T00:00:00.000Z");
  const WIN_END = new Date("2026-10-01T00:00:00.000Z");

  it("returns byte-identical UTC instants to two different callers", async () => {
    const first = await source(db(NY, 1)).load({
      orgId: ORG,
      userId: "viewer-in-new-york",
      start: WIN_START,
      end: WIN_END,
    });
    const second = await source(db(NY, 2)).load({
      orgId: ORG,
      userId: "viewer-in-kolkata",
      start: WIN_START,
      end: WIN_END,
    });

    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.map((e) => e.start.toISOString())).toEqual(
      second.events.map((e) => e.start.toISOString()),
    );
    expect(first.events.map((e) => e.end.toISOString())).toEqual(
      second.events.map((e) => e.end.toISOString()),
    );
  });

  it("gives both callers the same occurrence ids, so a deep link resolves the same occurrence", async () => {
    const first = await source(db(NY, 1)).load({
      orgId: ORG,
      userId: "viewer-in-new-york",
      start: WIN_START,
      end: WIN_END,
    });
    const second = await source(db(NY, 2)).load({
      orgId: ORG,
      userId: "viewer-in-kolkata",
      start: WIN_START,
      end: WIN_END,
    });

    expect(first.events.map((e) => e.id)).toEqual(second.events.map((e) => e.id));
  });

  it("ships the AUTHORED zone, not a per-viewer one, so the reader can label the time honestly", async () => {
    const authored = await source(db(IST, 3)).load({
      orgId: ORG,
      userId: "viewer-in-new-york",
      start: WIN_START,
      end: WIN_END,
    });

    for (const event of authored.events) expect(event.meta["timezone"]).toBe(IST);
  });

  it("BITE: the authored zone is load-bearing — the same series in NY shifts by an hour across the fall-back that a UTC series does not", () => {
    const anchor = new Date("2026-10-19T13:00:00.000Z");
    const window = {
      start: new Date("2026-10-15T00:00:00.000Z"),
      end: new Date("2026-11-30T00:00:00.000Z"),
    };
    const expand = (timezone: string) =>
      expandToOccurrences(
        series({
          startDate: anchor,
          endDate: new Date(anchor.getTime() + 1_800_000),
          timezone,
          rrule: "FREQ=WEEKLY;BYDAY=MO",
        }),
        window.start,
        window.end,
      ).map((occ) => occ.startDate.toISOString().slice(11, 16));

    expect(new Set(expand(NY)).size).toBe(2);
    expect(new Set(expand("UTC")).size).toBe(1);
  });
});

describe("RSVP race safety rests on a real uniqueness constraint", () => {
  it("declares a unique constraint covering (org_id, event_id, membership_id) on event_attendees", () => {
    const config = getTableConfig(eventAttendees);
    const covering = config.uniqueConstraints.filter((constraint) => {
      const names = constraint.columns.map((column) => column.name).sort();
      return (
        names.length === 3 &&
        names.join(",") === ["org_id", "event_id", "membership_id"].sort().join(",")
      );
    });

    expect(covering).toHaveLength(1);
  });
});
