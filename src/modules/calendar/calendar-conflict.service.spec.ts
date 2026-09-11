import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { CalendarConflictService } from "./calendar-conflict.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { TenantTx } from "../../db/drizzle.types";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();

function renderCond(cond: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(cond as SQL);
}

const WINDOW_START = new Date("2024-03-10T09:00:00Z");
const WINDOW_END = new Date("2024-03-10T10:00:00Z");

function makeEventRow(overrides: {
  id?: number;
  orgId?: string;
  createdByMembershipId?: number;
  startDate?: Date;
  endDate?: Date;
  allDay?: boolean;
  rrule?: string | null;
}) {
  return {
    id: overrides.id ?? 1,
    title: "Meeting",
    startDate: overrides.startDate ?? WINDOW_START,
    endDate: overrides.endDate ?? WINDOW_END,
    allDay: overrides.allDay ?? false,
    timezone: "UTC",
    orgId: overrides.orgId ?? "org-1",
    createdByMembershipId: overrides.createdByMembershipId ?? 99,
    rrule: overrides.rrule ?? null,
    recurrenceEnd: null,
  };
}

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

interface TxProbe {
  tx: TenantTx;
  whereArgs: unknown[];
  memberFindFirst: jest.Mock;
  /** The predicate the candidate drain built, and the one the exception load built. */
  candidateWhere: () => unknown;
  exceptionWhere: () => unknown;
  semiJoinWhere: () => unknown;
}

/**
 * Dispatches on the PROJECTION rather than on call order.
 *
 * `checkConflictsInTx` now builds a semi-join subquery (`select({ one: sql\`1\` })`) before
 * the drain, so the caller's own events and the events they attend are filtered in SQL
 * instead of in memory. That subquery is a `tx.select` like any other, and a mock keyed on
 * "first call / second call" silently answers the wrong query once one is added. Keying on
 * the fields each query asks for cannot drift that way.
 */
function makeTxProbe(
  eventRows: ReturnType<typeof makeEventRow>[],
  attendeeRows: Array<{ eventId: number; status: string }>,
  exceptionRows: Array<{
    eventId: number;
    occurrenceStart: Date;
    isCancelled: boolean;
    modifiedTitle: string | null;
    modifiedStart: Date | null;
    modifiedEnd: Date | null;
  }> = [],
): TxProbe {
  const whereArgs: unknown[] = [];
  const byQuery = new Map<string, unknown>();
  const memberFindFirst = jest.fn().mockResolvedValue({ id: 1 });
  const record = (kind: string, arg: unknown) => {
    whereArgs.push(arg);
    if (!byQuery.has(kind)) byQuery.set(kind, arg);
  };

  const tx = {
    query: { organizationMembers: { findFirst: memberFindFirst } },
    select: jest.fn().mockImplementation((fields: Record<string, unknown> | undefined) => {
      const keys = Object.keys(fields ?? {});
      const has = (key: string) => keys.includes(key);

      // The semi-join subquery: never awaited, only embedded in the drain's predicate.
      // Its own predicate is captured, because a mocked builder renders inside the outer
      // SQL as an opaque parameter and the outer text alone cannot show what it joins on.
      if (has("one"))
        return {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockImplementation(function (this: unknown, arg: unknown) {
            record("semijoin", arg);
            return this;
          }),
        };

      if (has("rrule") && has("createdByMembershipId"))
        return {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockImplementation(function (this: unknown, arg: unknown) {
            record("candidates", arg);
            return this;
          }),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue(eventRows),
        };

      if (has("occurrenceStart"))
        return {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockImplementation((arg: unknown) => {
            record("exceptions", arg);
            return Promise.resolve(exceptionRows);
          }),
        };

      return {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockImplementation((arg: unknown) => {
          record("attendees", arg);
          return Promise.resolve(attendeeRows);
        }),
      };
    }),
  } as unknown as TenantTx;

  return {
    tx,
    whereArgs,
    memberFindFirst,
    candidateWhere: () => byQuery.get("candidates"),
    exceptionWhere: () => byQuery.get("exceptions"),
    semiJoinWhere: () => byQuery.get("semijoin"),
  };
}

function makeTx(eventRows: ReturnType<typeof makeEventRow>[], attendeeRows: Array<{ eventId: number; status: string }>): TenantTx {
  return makeTxProbe(eventRows, attendeeRows).tx;
}

describe("CalendarConflictService.checkConflictsInTx", () => {
  let service: CalendarConflictService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        CalendarConflictService,
        { provide: DRIZZLE, useValue: { transaction: jest.fn() } },
      ],
    }).compile();
    service = module.get(CalendarConflictService);
  });

  it("returns an occurrence when the organizer has a conflicting event", async () => {
    const tx = makeTx([makeEventRow({ createdByMembershipId: 1 })], []);
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe(1);
  });

  it("returns an occurrence when the user is an accepted attendee", async () => {
    const tx = makeTx(
      [makeEventRow({ id: 5, createdByMembershipId: 2 })],
      [{ eventId: 5, status: "accepted" }],
    );
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(1);
  });

  it("excludes the event when the user declined the invitation", async () => {
    const tx = makeTx(
      [makeEventRow({ id: 7, createdByMembershipId: 2 })],
      [{ eventId: 7, status: "declined" }],
    );
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(0);
  });

  it("excludes an event the user is neither organizer of nor invited to", async () => {
    const tx = makeTx([makeEventRow({ createdByMembershipId: 2 })], []);
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(0);
  });

  it("returns empty when there are no overlapping events", async () => {
    const tx = makeTx([], []);
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(0);
  });

  it("cross-tenant isolation: orgId is always bound (select is called with org-scoped predicates)", async () => {
    // This test asserted nothing at all: it called the service and ended. It was
    // green whether or not a single predicate carried the org.
    const { tx, whereArgs, memberFindFirst } = makeTxProbe(
      [makeEventRow({ createdByMembershipId: 1 })],
      [],
    );

    await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);

    const memberWhere = memberFindFirst.mock.calls[0]?.[0] as { where: unknown };
    expect(sqlValues(memberWhere.where)).toContain("org-1");

    // Every predicate individually: one org-unbound predicate among org-bound
    // siblings is invisible to a flattened check.
    //
    // There are two ways a predicate can be org-bound, and the semi-join added for the
    // ownership push-down uses the second: it does not bind the literal, it CORRELATES to
    // the outer row's `calendar_events.org_id`, which is itself bound to this org. The
    // correlation is checked by its exact text — `event_attendees.org_id =
    // calendar_events.org_id` — so a predicate that merely mentions some other column
    // still counts as unbound.
    const CORRELATED_TO_OUTER_ORG =
      '"event_attendees"."org_id" = "calendar_events"."org_id"';
    expect(whereArgs.length).toBeGreaterThan(0);
    const unbound = whereArgs
      .map((w, i) => ({ i, values: sqlValues(w), sql: renderCond(w).sql }))
      .filter((e) => !e.values.includes("org-1") && !e.sql.includes(CORRELATED_TO_OUTER_ORG))
      .map((e) => `predicate #${e.i} does not bind the org: ${JSON.stringify(e.values)}`);
    expect(unbound).toEqual([]);
    expect(whereArgs.flatMap((w) => sqlValues(w))).not.toContain("org-2");
  });

  it("includes a pending attendee (not yet responded)", async () => {
    const tx = makeTx(
      [makeEventRow({ id: 9, createdByMembershipId: 2 })],
      [{ eventId: 9, status: "pending" }],
    );
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(1);
  });

  it("DST spring-forward: event spanning the DST gap is still a conflict", async () => {
    const dstStart = new Date("2024-03-10T06:59:00Z");
    const dstEnd = new Date("2024-03-10T07:30:00Z");
    const tx = makeTx(
      [makeEventRow({ createdByMembershipId: 1, startDate: dstStart, endDate: dstEnd })],
      [],
    );
    const winStart = new Date("2024-03-10T06:00:00Z");
    const winEnd = new Date("2024-03-10T08:00:00Z");
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", winStart, winEnd);
    expect(result).toHaveLength(1);
  });

  it("cancelled/declined attendance is not a conflict", async () => {
    const tx = makeTx(
      [makeEventRow({ id: 11, createdByMembershipId: 2 })],
      [{ eventId: 11, status: "declined" }],
    );
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(0);
  });
});

describe("CalendarConflictService.checkConflicts wraps a transaction", () => {
  it("invokes db.transaction and passes its result through", async () => {
    const fakeOccurrence = {
      eventId: 1,
      title: "Fake",
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      allDay: false,
      timezone: "UTC",
      orgId: "org-1",
    };
    const mockDb = {
      transaction: jest.fn(async (fn: (tx: TenantTx) => Promise<unknown>) => {
        const tx = makeTx([makeEventRow({ createdByMembershipId: 1 })], []);
        return fn(tx);
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CalendarConflictService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();
    const svc = module.get(CalendarConflictService);

    const result = await svc.checkConflicts("org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ eventId: 1 });
    void fakeOccurrence;
  });
});

/**
 * The conflict check ran on every `POST /calendar/events`, inside the write transaction,
 * and its cost grew with the size of the tenant rather than with the meeting being booked:
 * the keyset drain had no ownership predicate, so it loaded every open-ended recurring
 * series the organisation had ever created (the loop deliberately consumes every batch),
 * and the exception load that followed had no window predicate and no limit at all.
 *
 * Measured on scratch_head_1010 as `streamline_app` with the tenant GUC set, seeded with
 * 5,000 open weekly series of which the caller owns 50, and 50,000 exception rows:
 *
 *   candidate drain  5,000 rows / ~50 keyset round trips  →  50 rows / 1 round trip
 *   exception load   65,058 buffers / 50,000 rows loaded  →  775 buffers / 0 loaded
 *
 * Worth recording that bounding the exception load ALONE — the fix the audit proposed —
 * moved 65,058 buffers to 65,126: no improvement whatever, because the cost is one index
 * probe per candidate event, not the rows returned. The candidate narrowing is what pays;
 * the window bound then keeps the rows that reach the RRULE expander small.
 */
describe("the conflict scan is bounded by the caller and the window, not by tenant size", () => {
  async function probeOnce(exceptionRows: Parameters<typeof makeTxProbe>[2] = []) {
    const probe = makeTxProbe(
      [makeEventRow({ createdByMembershipId: 1, rrule: "FREQ=WEEKLY;BYDAY=SU" })],
      [],
      exceptionRows,
    );
    const module = await Test.createTestingModule({
      providers: [CalendarConflictService, { provide: DRIZZLE, useValue: { transaction: jest.fn() } }],
    }).compile();
    await module
      .get(CalendarConflictService)
      .checkConflictsInTx(probe.tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    return probe;
  }

  it("asks the database only for events the caller organises or attends", async () => {
    const probe = await probeOnce();
    const { sql, params } = renderCond(probe.candidateWhere());

    // The caller's own membership, and a semi-join against their attendee rows: both arms
    // of the filter that used to run in JS after every row had already been loaded.
    expect(sql).toContain("created_by_membership_id");
    expect(sql.toLowerCase()).toContain("exists");
    expect(params).toContain(1);

    // …and the semi-join is against THIS caller's attendee rows for THIS event, correlated
    // to the outer row rather than a standalone lookup.
    const semiJoin = renderCond(probe.semiJoinWhere());
    expect(semiJoin.sql).toContain("event_attendees");
    expect(semiJoin.sql).toContain("calendar_events");
    expect(semiJoin.sql).toContain("membership_id");
    expect(semiJoin.params).toContain(1);
  });

  it("bounds the exception load to the requested window", async () => {
    const probe = await probeOnce([
      {
        eventId: 1,
        occurrenceStart: WINDOW_START,
        isCancelled: false,
        modifiedTitle: null,
        modifiedStart: null,
        modifiedEnd: null,
      },
    ]);
    const { sql, params } = renderCond(probe.exceptionWhere());

    expect(sql).toContain("occurrence_start");
    expect(sql).toContain("modified_start");
    // Drizzle maps a Date through the timestamp column's driver mapper, so the window
    // arrives in `params` as a string rather than as a Date.
    const bound = params.flatMap((param) => {
      if (param instanceof Date) return [param.getTime()];
      if (typeof param !== "string") return [];
      const parsed = Date.parse(/[Z+]/.test(param) ? param : `${param}Z`);
      return Number.isNaN(parsed) ? [] : [parsed];
    });
    expect(bound).toContain(WINDOW_START.getTime());
    expect(bound).toContain(WINDOW_END.getTime());
  });

  it("still returns the conflict it was asked about", async () => {
    // Anti-vacuity: a predicate that excluded everything would satisfy both tests above.
    const probe = makeTxProbe([makeEventRow({ createdByMembershipId: 1 })], []);
    const module = await Test.createTestingModule({
      providers: [CalendarConflictService, { provide: DRIZZLE, useValue: { transaction: jest.fn() } }],
    }).compile();
    const result = await module
      .get(CalendarConflictService)
      .checkConflictsInTx(probe.tx, "org-1", "user-1", WINDOW_START, WINDOW_END);

    expect(result).toHaveLength(1);
  });
});
