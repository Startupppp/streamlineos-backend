import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  collectRescheduledOccurrences,
  exceptionsInWindow,
  loadExceptionsByEvent,
} from "./calendar-exception-loader";
import type { CalendarEventException } from "./calendar-occurrence.service";

const dialect = new PgDialect();

const WINDOW_START = new Date("2026-09-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-11-01T00:00:00.000Z");
const START_BOUND = WINDOW_START.toISOString();
const END_BOUND = WINDOW_END.toISOString();
const ORG = "org-exception-loader";

interface ExceptionRow {
  id: number;
  eventId: number;
  occurrenceStart: Date;
  isCancelled: boolean;
  modifiedTitle: string | null;
  modifiedStart: Date | null;
  modifiedEnd: Date | null;
}

interface Captured {
  selects: number;
  where: SQL | undefined;
  wheres: Array<SQL | undefined>;
  limit: number | undefined;
  limits: number[];
}

interface FakeBuilder {
  from(): FakeBuilder;
  where(cond: SQL | undefined): FakeBuilder;
  orderBy(): FakeBuilder;
  limit(value: number): Promise<ExceptionRow[]>;
}

function makeDb(rows: ExceptionRow[]): { db: Db; captured: Captured } {
  const captured: Captured = { selects: 0, where: undefined, wheres: [], limit: undefined, limits: [] };
  const ordered = [...rows].sort((a, b) => a.eventId - b.eventId || a.id - b.id);
  let served = 0;
  const builder: FakeBuilder = {
    from(): FakeBuilder {
      return builder;
    },
    where(cond: SQL | undefined): FakeBuilder {
      captured.where = cond;
      captured.wheres.push(cond);
      return builder;
    },
    orderBy(): FakeBuilder {
      return builder;
    },
    limit(value: number): Promise<ExceptionRow[]> {
      captured.limit = value;
      captured.limits.push(value);
      const page = ordered.slice(served, served + value);
      served += page.length;
      return Promise.resolve(page);
    },
  };
  const db = {
    select(): FakeBuilder {
      captured.selects += 1;
      return builder;
    },
  } as unknown as Db;
  return { db, captured };
}

function renderWindow(): { sql: string; params: unknown[] } {
  const cond = exceptionsInWindow(WINDOW_START, WINDOW_END);
  expect(cond).toBeDefined();
  if (!cond) throw new Error("exceptionsInWindow returned no predicate");
  const query = dialect.sqlToQuery(cond);
  return { sql: query.sql, params: query.params };
}

let nextRowId = 1;

function row(overrides: Partial<ExceptionRow> & { eventId: number }): ExceptionRow {
  nextRowId += 1;
  return {
    id: nextRowId,
    occurrenceStart: new Date("2026-09-10T09:00:00.000Z"),
    isCancelled: false,
    modifiedTitle: null,
    modifiedStart: null,
    modifiedEnd: null,
    ...overrides,
  };
}

function fullWindowFixture(eventCount: number, perEvent: number): ExceptionRow[] {
  const rows: ExceptionRow[] = [];
  let id = 1;
  for (let e = 1; e <= eventCount; e += 1)
    for (let i = 0; i < perEvent; i += 1) {
      id += 1;
      rows.push(
        row({
          id,
          eventId: e,
          occurrenceStart: new Date(WINDOW_START.getTime() + i * 3_600_000),
          isCancelled: i % 2 === 0,
        }),
      );
    }
  return rows;
}

describe("exceptionsInWindow", () => {
  it("closes the occurrence_start arm on BOTH sides, so it cannot read the whole series history", () => {
    const { sql } = renderWindow();
    expect(sql).toContain('"calendar_event_exceptions"."occurrence_start" >= ');
    expect(sql).toContain('"calendar_event_exceptions"."occurrence_start" < ');
  });

  it("closes the modified_start arm on BOTH sides, so a rescheduled occurrence is bounded too", () => {
    const { sql } = renderWindow();
    expect(sql).toContain('"calendar_event_exceptions"."modified_start" is not null');
    expect(sql).toContain('"calendar_event_exceptions"."modified_start" >= ');
    expect(sql).toContain('"calendar_event_exceptions"."modified_start" < ');
  });

  it("binds only the two window bounds, never an open-ended comparison", () => {
    const { params } = renderWindow();
    expect(params).toHaveLength(4);
    for (const param of params) expect([START_BOUND, END_BOUND]).toContain(param);
    expect(params.filter((p) => p === START_BOUND)).toHaveLength(2);
    expect(params.filter((p) => p === END_BOUND)).toHaveLength(2);
  });
});

describe("loadExceptionsByEvent", () => {
  it("issues no query at all for an empty recurring-event list", async () => {
    const { db, captured } = makeDb([]);
    const result = await loadExceptionsByEvent(db, ORG, [], WINDOW_START, WINDOW_END);
    expect(result.byEvent.size).toBe(0);
    expect(result.complete).toBe(true);
    expect(captured.selects).toBe(0);
  });

  it("carries a finite row cap, so one pass can never stream an unbounded result set", async () => {
    const { db, captured } = makeDb([]);
    await loadExceptionsByEvent(db, ORG, [11, 12], WINDOW_START, WINDOW_END);
    expect(captured.selects).toBe(1);
    expect(typeof captured.limit).toBe("number");
    expect(Number.isFinite(captured.limit)).toBe(true);
    expect(captured.limit).toBeGreaterThan(0);
  });

  it("binds the tenant, every requested event id and both window bounds into one predicate", async () => {
    const { db, captured } = makeDb([]);
    await loadExceptionsByEvent(db, ORG, [11, 12], WINDOW_START, WINDOW_END);
    expect(captured.where).toBeDefined();
    if (!captured.where) throw new Error("no predicate captured");
    const query = dialect.sqlToQuery(captured.where);
    expect(query.sql).toContain('"calendar_event_exceptions"."org_id"');
    expect(query.sql).toContain('"calendar_event_exceptions"."event_id"');
    expect(query.params).toContain(ORG);
    expect(query.params).toContain(11);
    expect(query.params).toContain(12);
    expect(query.params.filter((p) => p === START_BOUND)).toHaveLength(2);
    expect(query.params.filter((p) => p === END_BOUND)).toHaveLength(2);
  });

  it("groups the single pass by event id without losing a row", async () => {
    const rows = [
      row({ eventId: 11 }),
      row({ eventId: 11, occurrenceStart: new Date("2026-09-11T09:00:00.000Z"), isCancelled: true }),
      row({ eventId: 12, occurrenceStart: new Date("2026-09-12T09:00:00.000Z") }),
    ];
    const { db } = makeDb(rows);
    const { byEvent, complete } = await loadExceptionsByEvent(db, ORG, [11, 12], WINDOW_START, WINDOW_END);
    expect(byEvent.get(11)).toHaveLength(2);
    expect(byEvent.get(12)).toHaveLength(1);
    expect(byEvent.get(11)?.[1]?.isCancelled).toBe(true);
    expect(complete).toBe(true);
  });
});

describe("loadExceptionsByEvent — completeness at a LEGAL maximum window (CA2)", () => {
  const EVENTS = 400;
  const PER_EVENT = 28;
  const eventIds = Array.from({ length: EVENTS }, (_, i) => i + 1);

  it("leaves no series without its exceptions when the window matches more rows than one page", async () => {
    const rows = fullWindowFixture(EVENTS, PER_EVENT);
    expect(rows.length).toBe(11_200);
    const { db } = makeDb(rows);

    const { byEvent, complete } = await loadExceptionsByEvent(db, ORG, eventIds, WINDOW_START, WINDOW_END);

    expect(complete).toBe(true);
    expect(byEvent.size).toBe(EVENTS);
    for (const eventId of eventIds) expect(byEvent.get(eventId)).toHaveLength(PER_EVENT);
  });

  it("keeps the cancelled/moved semantics of the LAST series, which a single capped pass dropped entirely", async () => {
    const rows = fullWindowFixture(EVENTS, PER_EVENT);
    const { db } = makeDb(rows);

    const { byEvent } = await loadExceptionsByEvent(db, ORG, eventIds, WINDOW_START, WINDOW_END);

    const last = byEvent.get(EVENTS) ?? [];
    expect(last.filter((ex) => ex.isCancelled)).toHaveLength(Math.ceil(PER_EVENT / 2));
  });

  it("continues past the last (event_id, id) pair instead of re-reading the first page", async () => {
    const rows = fullWindowFixture(60, 400);
    const { db, captured } = makeDb(rows);

    await loadExceptionsByEvent(db, ORG, Array.from({ length: 60 }, (_, i) => i + 1), WINDOW_START, WINDOW_END);

    expect(captured.selects).toBeGreaterThan(1);
    const second = captured.wheres[1];
    expect(second).toBeDefined();
    if (!second) throw new Error("no continuation predicate captured");
    const query = dialect.sqlToQuery(second);
    expect(query.sql).toContain('"calendar_event_exceptions"."event_id", "calendar_event_exceptions"."id") >');
  });

  it("re-binds the tenant and the requested event ids on EVERY continuation page", async () => {
    const rows = fullWindowFixture(60, 400);
    const { db, captured } = makeDb(rows);

    await loadExceptionsByEvent(db, ORG, Array.from({ length: 60 }, (_, i) => i + 1), WINDOW_START, WINDOW_END);

    expect(captured.wheres.length).toBeGreaterThan(1);
    for (const where of captured.wheres) {
      expect(where).toBeDefined();
      if (!where) throw new Error("page issued with no predicate");
      const query = dialect.sqlToQuery(where);
      expect(query.sql).toContain('"calendar_event_exceptions"."org_id"');
      expect(query.params).toContain(ORG);
      expect(query.params.filter((p) => p === START_BOUND)).toHaveLength(2);
      expect(query.params.filter((p) => p === END_BOUND)).toHaveLength(2);
    }
  });

  it("reports complete:false rather than presenting a partial map as whole when the hard bound bites", async () => {
    const rows = fullWindowFixture(1, 900);
    const { db } = makeDb(rows);

    const { byEvent, complete } = await loadExceptionsByEvent(db, ORG, [1], WINDOW_START, WINDOW_END);

    expect(complete).toBe(false);
    expect(byEvent.get(1)).toHaveLength(500);
  });

  it("recovers completeness when the caller narrows the range to a set inside the bound", async () => {
    const wide = fullWindowFixture(1, 900);
    const narrowed = wide.slice(0, 120);
    const { db } = makeDb(narrowed);

    const { byEvent, complete } = await loadExceptionsByEvent(
      db,
      ORG,
      [1],
      WINDOW_START,
      new Date(WINDOW_START.getTime() + 120 * 3_600_000),
    );

    expect(complete).toBe(true);
    expect(byEvent.get(1)).toHaveLength(120);
  });
});

describe("collectRescheduledOccurrences", () => {
  const event = {
    title: "Standup",
    startDate: new Date("2026-01-05T09:00:00.000Z"),
    endDate: new Date("2026-01-05T09:30:00.000Z"),
  };

  function exception(overrides: Partial<CalendarEventException>): CalendarEventException {
    return {
      occurrenceStart: new Date("2026-08-20T09:00:00.000Z"),
      isCancelled: false,
      modifiedTitle: null,
      modifiedStart: new Date("2026-09-15T14:00:00.000Z"),
      modifiedEnd: null,
      ...overrides,
    };
  }

  it("emits an occurrence whose nominal instant sits OUTSIDE the window but was moved inside", () => {
    const out = collectRescheduledOccurrences(event, [exception({})], WINDOW_START, WINDOW_END);
    expect(out).toHaveLength(1);
    expect(out[0]?.startDate.toISOString()).toBe("2026-09-15T14:00:00.000Z");
    expect(out[0]?.endDate.toISOString()).toBe("2026-09-15T14:30:00.000Z");
    expect(out[0]?.title).toBe("Standup");
  });

  it("does NOT emit an occurrence whose nominal instant is ALSO inside the window, which the expander already renders", () => {
    const both = exception({
      occurrenceStart: new Date("2026-09-10T09:00:00.000Z"),
      modifiedStart: new Date("2026-09-10T14:00:00.000Z"),
    });
    expect(collectRescheduledOccurrences(event, [both], WINDOW_START, WINDOW_END)).toHaveLength(0);
  });

  it("drops a cancelled exception and one with no modified instant", () => {
    const cancelled = exception({ isCancelled: true });
    const unmoved = exception({ modifiedStart: null });
    expect(
      collectRescheduledOccurrences(event, [cancelled, unmoved], WINDOW_START, WINDOW_END),
    ).toHaveLength(0);
  });

  it("drops an exception moved to an instant outside the window", () => {
    const moved = exception({ modifiedStart: new Date("2026-12-01T14:00:00.000Z") });
    expect(collectRescheduledOccurrences(event, [moved], WINDOW_START, WINDOW_END)).toHaveLength(0);
  });

  it("prefers the stored modified end and the stored modified title", () => {
    const moved = exception({
      modifiedTitle: "Moved standup",
      modifiedEnd: new Date("2026-09-15T16:00:00.000Z"),
    });
    const out = collectRescheduledOccurrences(event, [moved], WINDOW_START, WINDOW_END);
    expect(out[0]?.title).toBe("Moved standup");
    expect(out[0]?.endDate.toISOString()).toBe("2026-09-15T16:00:00.000Z");
    expect(out[0]?.nominalStartMs).toBe(new Date("2026-08-20T09:00:00.000Z").getTime());
  });
});
