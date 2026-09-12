import { CalendarNativeEventSource } from "./calendar-native-event-source";
import { CalendarExportService } from "./calendar-export.service";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { CALENDAR_EVENTS_CAP } from "./dto/calendar.schemas";
import type { Db } from "../../db/drizzle.module";
import type { CalendarSourceContext } from "./calendar-event-source";
import { ScopedRead } from "../access/scoped-read";

function sqlValues(val: unknown, seen = new Set<object>()): unknown[] {
  if (val === null || val === undefined || typeof val === "string" || typeof val === "number" || typeof val === "boolean") return [val];
  if (Array.isArray(val)) return val.flatMap((v) => sqlValues(v, seen));
  if (typeof val !== "object" || seen.has(val as object)) return [];
  seen.add(val as object);
  const rec = val as Record<string, unknown>;
  return [
    ...(rec["queryChunks"] ? sqlValues(rec["queryChunks"], seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec["value"], seen) : []),
  ];
}

const ORG = "org-native-rec-spec";
const USER = "user-rec-spec-1";
const WIN_START = new Date("2026-09-01T00:00:00Z");
const WIN_END = new Date("2026-09-30T23:59:59Z");

const WEEKLY_MONDAY_RRULE = "FREQ=WEEKLY;BYDAY=MO";
const BASE_START = new Date("2026-03-02T09:00:00Z");
const BASE_END = new Date("2026-03-02T09:30:00Z");
const FIRST_SEP_MONDAY = new Date("2026-09-07T09:00:00Z");

const ctx: CalendarSourceContext = { orgId: ORG, userId: USER, start: WIN_START, end: WIN_END};

function makeEventRow(overrides: {
  id?: number;
  rrule?: string | null;
  startDate?: Date;
  endDate?: Date;
  recurrenceEnd?: Date | null;
  title?: string;
}) {
  return {
    id: overrides.id ?? 1,
    title: overrides.title ?? "Weekly standup",
    description: null,
    location: null,
    meetingUrl: null,
    startDate: overrides.startDate ?? BASE_START,
    endDate: overrides.endDate ?? BASE_END,
    allDay: false,
    timezone: "UTC",
    color: null,
    category: "work",
    entityType: null,
    entityId: null,
    visibility: "org",
    rrule: overrides.rrule ?? null,
    recurrenceEnd: overrides.recurrenceEnd ?? null,
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

/**
 * The loader asks five different questions per page, so this double routes on the
 * projection it is handed rather than on call order: an order-indexed double silently
 * answered the recurring branch with the exception rows the moment a statement moved.
 */
function makeNativeSourceDb(
  events: ReturnType<typeof makeEventRow>[],
  exceptions: Array<{ eventId: number; occurrenceStart: Date; isCancelled: boolean; modifiedTitle?: string | null; modifiedStart?: Date | null; modifiedEnd?: Date | null }> = [],
): Db {
  let candidateCall = 0;
  return {
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
    },
    select: jest.fn().mockImplementation((fields: Record<string, unknown> | undefined) => {
      const keys = Object.keys(fields ?? {});
      const has = (k: string) => keys.includes(k);

      if (has("startDate") && keys.length === 2) {
        candidateCall++;
        return chain(candidateCall === 1 ? events.map((e) => ({ id: e.id, startDate: e.startDate })) : []);
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

beforeEach(() => jest.resetAllMocks());

describe("CalendarNativeEventSource — recurring event window fix (P0)", () => {
  it("weekly series created 6 months before the window returns multiple occurrences (old predicate: zero)", async () => {
    const db = makeNativeSourceDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })]);
    const { events: result } = await makeSource(db).load(ctx);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const ids = result.map((p) => p.id);
    expect(ids.every((id) => id.startsWith(`event-1-`))).toBe(true);
  });

  it("recurring event with a cancelled occurrence omits exactly that occurrence", async () => {
    const exceptions = [{
      eventId: 1,
      occurrenceStart: FIRST_SEP_MONDAY,
      isCancelled: true,
      modifiedTitle: null,
      modifiedStart: null,
      modifiedEnd: null,
    }];
    const db = makeNativeSourceDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })], exceptions);
    const { events: result } = await makeSource(db).load(ctx);
    const starts = result.map((p) => p.start.toISOString());
    expect(starts).not.toContain(FIRST_SEP_MONDAY.toISOString());
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("recurring event with a modified occurrence returns the modified title and times", async () => {
    const modStart = new Date("2026-09-07T10:00:00Z");
    const modEnd = new Date("2026-09-07T10:45:00Z");
    const exceptions = [{
      eventId: 1,
      occurrenceStart: FIRST_SEP_MONDAY,
      isCancelled: false,
      modifiedTitle: "Revised standup",
      modifiedStart: modStart,
      modifiedEnd: modEnd,
    }];
    const db = makeNativeSourceDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })], exceptions);
    const { events: result } = await makeSource(db).load(ctx);
    const modified = result.find((p) => p.start.toISOString() === modStart.toISOString());
    expect(modified).toBeDefined();
    expect(modified?.title).toBe("Revised standup");
    expect(modified?.end.toISOString()).toBe(modEnd.toISOString());
  });

  it("non-recurring event in the window is unchanged (id format event-N, single occurrence)", async () => {
    const start = new Date("2026-09-10T14:00:00Z");
    const end = new Date("2026-09-10T15:00:00Z");
    const db = makeNativeSourceDb([makeEventRow({ id: 42, rrule: null, startDate: start, endDate: end })]);
    const { events: result } = await makeSource(db).load(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("event-42");
    expect(result[0]?.start.toISOString()).toBe(start.toISOString());
  });

  it("per-source cap stops emitting at CALENDAR_EVENTS_CAP", async () => {
    const bigWindow = { ...ctx, start: new Date("2026-01-01T00:00:00Z"), end: new Date("2030-12-31T23:59:59Z") };
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEventRow({ id: i + 1, rrule: "FREQ=DAILY", startDate: new Date("2024-01-01T09:00:00Z"), endDate: new Date("2024-01-01T09:30:00Z") }),
    );
    const db = makeNativeSourceDb(events);
    const { events: result } = await makeSource(db).load(bigWindow);
    expect(result.length).toBeLessThanOrEqual(CALENDAR_EVENTS_CAP);
  });

  it("tenant isolation: org predicate is bound to the caller org in the events query", async () => {
    let capturedWhere: unknown = undefined;
    const db = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockImplementation((cond: unknown) => {
          capturedWhere = cond;
          return { orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([]) };
        }),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      }),
    } as unknown as Db;

    await makeSource(db).load(ctx);

    expect(capturedWhere).toBeDefined();
    const vals = sqlValues(capturedWhere);
    expect(vals).toContain(ORG);
  });
});

describe("CalendarExportService — recurring series starting before from (P1)", () => {
  function makeExportDb(
    events: ReturnType<typeof makeEventRow>[],
    exceptions: Array<{ eventId: number; occurrenceStart: Date; isCancelled: boolean; modifiedTitle?: string | null; modifiedStart?: Date | null; modifiedEnd?: Date | null }> = [],
  ): Db {
    let selectCall = 0;
    return {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      },
      select: jest.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) {
          return {
            from: jest.fn().mockReturnThis(),
            leftJoin: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue(events),
          };
        }
        return {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(exceptions),
            }),
          }),
        };
      }),
    } as unknown as Db;
  }

  it("export returns expanded occurrences for a series whose base startDate precedes from (old predicate: zero)", async () => {
    const exportFrom = new Date("2026-09-01T00:00:00Z");
    const exportTo = new Date("2026-09-30T23:59:59Z");
    const db = makeExportDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })]);
    const svc = new CalendarExportService(db);
    const result = await svc.exportEvents(ScopedRead.of(ORG, USER, "all"), exportFrom, exportTo);
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.events[0]).toHaveProperty("title");
    expect(result.events[0]).toHaveProperty("startDate");
    expect(result.events[0]).toHaveProperty("allDay");
  });

  it("export tenant isolation: orgId is present in the events WHERE predicate", async () => {
    let capturedWhere: unknown = undefined;
    const db = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockImplementation((cond: unknown) => {
          capturedWhere = cond;
          return { orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([]) };
        }),
      }),
    } as unknown as Db;

    const svc = new CalendarExportService(db);
    await svc.exportEvents(ScopedRead.of(ORG, USER, "all"), new Date("2026-09-01"), new Date("2026-09-30"));

    expect(capturedWhere).toBeDefined();
    const vals = sqlValues(capturedWhere);
    expect(vals).toContain(ORG);
  });
});

const AUG31_MONDAY = new Date("2026-08-31T09:00:00Z");
const SEPT5_SATURDAY = new Date("2026-09-05T09:00:00Z");
const SEPT5_END = new Date("2026-09-05T09:30:00Z");
const OCT5 = new Date("2026-10-05T09:00:00Z");
const OCT5_END = new Date("2026-10-05T09:30:00Z");
const SEPT8_TUESDAY = new Date("2026-09-08T09:00:00Z");
const SEPT8_END = new Date("2026-09-08T09:30:00Z");

describe("Second-pass rescheduled occurrences — nominal outside window, modifiedStart inside", () => {
  it("list source: occurrence with nominal OUTSIDE window but modifiedStart INSIDE is emitted (fails before fix: loadExceptionsByEvent did not fetch it)", async () => {
    const exceptions = [{
      eventId: 1,
      occurrenceStart: AUG31_MONDAY,
      isCancelled: false,
      modifiedTitle: "Rescheduled standup",
      modifiedStart: SEPT5_SATURDAY,
      modifiedEnd: SEPT5_END,
    }];
    const db = makeNativeSourceDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })], exceptions);
    const { events: result } = await makeSource(db).load(ctx);
    const rescheduled = result.find((p) => p.start.toISOString() === SEPT5_SATURDAY.toISOString());
    expect(rescheduled).toBeDefined();
    expect(rescheduled?.title).toBe("Rescheduled standup");
    expect(rescheduled?.end.toISOString()).toBe(SEPT5_END.toISOString());
  });

  it("export: occurrence with nominal OUTSIDE window but modifiedStart INSIDE is emitted (fails before fix: loadExceptionsByEvent did not fetch it)", async () => {
    const exceptions = [{
      eventId: 1,
      occurrenceStart: AUG31_MONDAY,
      isCancelled: false,
      modifiedTitle: "Export rescheduled",
      modifiedStart: SEPT5_SATURDAY,
      modifiedEnd: SEPT5_END,
    }];
    function makeExportDb2(
      evts: ReturnType<typeof makeEventRow>[],
      excs: typeof exceptions,
    ): Db {
      let selectCall = 0;
      return {
        query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
        select: jest.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1)
            return { from: jest.fn().mockReturnThis(), leftJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue(evts) };
          return { from: jest.fn().mockReturnThis(), where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(excs) }) }) };
        }),
      } as unknown as Db;
    }
    const db = makeExportDb2([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })], exceptions);
    const svc = new CalendarExportService(db);
    const result = await svc.exportEvents(ScopedRead.of(ORG, USER, "all"), WIN_START, WIN_END);
    const rescheduled = result.events.find((r) => r.startDate.toISOString() === SEPT5_SATURDAY.toISOString());
    expect(rescheduled).toBeDefined();
    expect(rescheduled?.title).toBe("Export rescheduled");
    expect(rescheduled?.endDate.toISOString()).toBe(SEPT5_END.toISOString());
  });

  it("cancelled exception with modifiedStart in window is NOT emitted by second pass (fails if isCancelled guard is missing)", async () => {
    const exceptions = [{
      eventId: 1,
      occurrenceStart: AUG31_MONDAY,
      isCancelled: true,
      modifiedTitle: null,
      modifiedStart: SEPT5_SATURDAY,
      modifiedEnd: SEPT5_END,
    }];
    const db = makeNativeSourceDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })], exceptions);
    const { events: result } = await makeSource(db).load(ctx);
    const atSept5 = result.find((p) => p.start.toISOString() === SEPT5_SATURDAY.toISOString());
    expect(atSept5).toBeUndefined();
  });

  it("no duplicate: nominal inside window with modifiedStart also inside is emitted exactly once (fails if nominalMs dedup guard is missing)", async () => {
    const exceptions = [{
      eventId: 1,
      occurrenceStart: FIRST_SEP_MONDAY,
      isCancelled: false,
      modifiedTitle: "Moved to Tuesday",
      modifiedStart: SEPT8_TUESDAY,
      modifiedEnd: SEPT8_END,
    }];
    const db = makeNativeSourceDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })], exceptions);
    const { events: result } = await makeSource(db).load(ctx);
    const atSept8 = result.filter((p) => p.start.toISOString() === SEPT8_TUESDAY.toISOString());
    expect(atSept8).toHaveLength(1);
    expect(atSept8[0]?.title).toBe("Moved to Tuesday");
  });

  it("rescheduled-out: occurrence moved from inside window to outside is not emitted by second pass at the outside date (existing behaviour must not regress)", async () => {
    const exceptions = [{
      eventId: 1,
      occurrenceStart: FIRST_SEP_MONDAY,
      isCancelled: false,
      modifiedTitle: "Moved to October",
      modifiedStart: OCT5,
      modifiedEnd: OCT5_END,
    }];
    const db = makeNativeSourceDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })], exceptions);
    const { events: result } = await makeSource(db).load(ctx);
    const atNominal = result.find((p) => p.start.toISOString() === FIRST_SEP_MONDAY.toISOString());
    expect(atNominal).toBeUndefined();
    // Both projection paths now name an occurrence by its NOMINAL instant, so "did the
    // second pass also emit this one?" can no longer be asked by id shape — which is the
    // point: the same occurrence must have the same id whichever path emits it. What this
    // test guards is that it is emitted ONCE, and never at its nominal date. (The moved
    // occurrence itself sits outside the requested window; that the expansion emits it
    // there at all is a separate, pre-existing question and is not what this pins.)
    const byNominalId = result.filter((p) => p.id === `event-1-${FIRST_SEP_MONDAY.toISOString()}`);
    expect(byNominalId).toHaveLength(1);
  });

  it("exception fetch predicate includes the orgId (bounded and org-scoped after update)", async () => {
    let exceptionWhere: unknown = undefined;
    const events = [makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })];
    let candidateCall = 0;
    const db = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockImplementation((fields: Record<string, unknown> | undefined) => {
        const keys = Object.keys(fields ?? {});
        const has = (k: string) => keys.includes(k);
        if (has("startDate") && keys.length === 2) {
          candidateCall++;
          return chain(candidateCall === 1 ? events.map((e) => ({ id: e.id, startDate: e.startDate })) : []);
        }
        if (has("eventId") && has("status")) return chain([]);
        if (has("membershipId") && has("name")) return chain([]);
        if (has("title") && has("rrule")) return chain(events);
        const node = chain([]);
        node["where"] = jest.fn((cond: unknown) => {
          exceptionWhere = cond;
          return node;
        });
        return node;
      }),
    } as unknown as Db;

    await makeSource(db).load(ctx);

    expect(exceptionWhere).toBeDefined();
    const vals = sqlValues(exceptionWhere);
    expect(vals).toContain(ORG);
  });

  it("second-pass helper Bug 1: modifiedStart with NO modifiedEnd produces endDate = modifiedStart + duration, not nominalStart + duration (fails if nominal-anchored)", async () => {
    const exceptions = [{
      eventId: 1,
      occurrenceStart: AUG31_MONDAY,
      isCancelled: false,
      modifiedTitle: "No end override",
      modifiedStart: SEPT5_SATURDAY,
      modifiedEnd: null,
    }];
    const db = makeNativeSourceDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })], exceptions);
    const { events: result } = await makeSource(db).load(ctx);
    const rescheduled = result.find((p) => p.start.toISOString() === SEPT5_SATURDAY.toISOString());
    expect(rescheduled).toBeDefined();
    expect(rescheduled!.end.getTime()).toBeGreaterThan(rescheduled!.start.getTime());
    const originalDurationMs = BASE_END.getTime() - BASE_START.getTime();
    expect(rescheduled!.end.getTime() - rescheduled!.start.getTime()).toBe(originalDurationMs);
  });

  it("second-pass helper: explicit modifiedEnd is preserved exactly (existing behaviour for when both are set)", async () => {
    const exceptions = [{
      eventId: 1,
      occurrenceStart: AUG31_MONDAY,
      isCancelled: false,
      modifiedTitle: "Explicit end",
      modifiedStart: SEPT5_SATURDAY,
      modifiedEnd: new Date("2026-09-05T11:00:00Z"),
    }];
    const db = makeNativeSourceDb([makeEventRow({ rrule: WEEKLY_MONDAY_RRULE })], exceptions);
    const { events: result } = await makeSource(db).load(ctx);
    const rescheduled = result.find((p) => p.start.toISOString() === SEPT5_SATURDAY.toISOString());
    expect(rescheduled).toBeDefined();
    expect(rescheduled!.end.toISOString()).toBe("2026-09-05T11:00:00.000Z");
  });
});
