jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName, type SQL } from "drizzle-orm";
import { CalendarService } from "./calendar.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";
import { updateAttendeesInTx } from "./calendar-attendee-sync";
import type { Db } from "../../db/drizzle.module";
import { ScopedRead } from "../access/scoped-read";

const dialect = new PgDialect();

function renderCond(cond: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(cond as SQL);
}

const ORG = "org-cancel-spec";
const USER = "user-spec-1";
const MEMBER_ID = 10;
const EVENT_ID = 99;

function makeInsertChain(returnedRows: unknown[]) {
  const returning = jest.fn().mockResolvedValue(returnedRows);
  const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  return { insert: jest.fn().mockReturnValue({ values }), returning };
}

/**
 * Records which TABLE each update targeted, not just that one happened.
 *
 * An occurrence write now also bumps the parent series' `local_version`/`updated_at`
 * (a local change the provider-drift comparison in `handleScoped` has to be able to
 * see), so "was an update issued" no longer answers "was a reminder dead-lettered".
 * The reminder assertions below therefore ask about `notification_outbox` specifically.
 */
function makeUpdateChain() {
  const targets: string[] = [];
  const where = jest
    .fn()
    .mockImplementation(() =>
      Object.assign(Promise.resolve([]), { returning: jest.fn().mockResolvedValue([]) }),
    );
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockImplementation((table: unknown) => {
    targets.push(getTableName(table as Parameters<typeof getTableName>[0]));
    return { set };
  });
  const outboxWhereCalls = () =>
    where.mock.calls
      .map((call, index) => ({ cond: call[0], table: targets[index] }))
      .filter((entry) => entry.table === "notification_outbox")
      .map((entry) => entry.cond);
  return { update, set, where, targets, outboxWhereCalls };
}

/** How many of those updates dead-lettered reminders. */
function outboxUpdates(chain: { targets: string[] }): string[] {
  return chain.targets.filter((table) => table === "notification_outbox");
}

function makeDeleteChain() {
  const where = jest.fn().mockResolvedValue([]);
  return { delete: jest.fn().mockReturnValue({ where }), where };
}

function makeSelectChain(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ where, innerJoin });
  return jest.fn().mockReturnValue({ from });
}

function makeService(db: unknown): CalendarService {
  const recurrence = new CalendarRecurrenceService(db as Db);
  const calendarExport = new CalendarExportService(db as Db);
  return new CalendarService(db as Db, {} as never, {} as never, {} as never, recurrence, calendarExport, {} as never);
}

describe("cancelOccurrence — kills PENDING outbox reminder for the specific occurrence", () => {
  beforeEach(() => jest.resetAllMocks());

  it("marks the matching occurrence dedupeKey DEAD in the same transaction (LIKE prefix covers per-attendee keys)", async () => {
    const occurrenceStart = new Date("2024-06-03T10:00:00Z");
    const expectedDedupeKey = `calendar:reminder:${EVENT_ID}:${occurrenceStart.toISOString()}%`;

    const insertChain = makeInsertChain([{ id: 1, eventId: EVENT_ID }]);
    const updateChain = makeUpdateChain();

    const tx = {
      // No exception rows: the occurrence-key resolution finds nothing and uses the
      // instant supplied, which is what these fixtures assume. The resolution itself is
      // covered by calendar-moved-occurrence-identity.spec.ts.
      select: makeSelectChain([]),
      insert: insertChain.insert,
      update: updateChain.update,
    };

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
        },
      },
      select: makeSelectChain([{ createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }]),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown[]>) => cb(tx)),
    };

    const svc = makeService(db);
    const result = await svc.cancelOccurrence(ORG, USER, EVENT_ID, occurrenceStart.toISOString());

    expect(result).toBeDefined();
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(outboxUpdates(updateChain)).toHaveLength(1);
    expect(updateChain.set).toHaveBeenCalledWith({ state: "DEAD" });

    const whereCond = updateChain.outboxWhereCalls()[0];
    const { params } = renderCond(whereCond);
    expect(params).toContain(ORG);
    expect(params).toContain("PENDING");
    expect(params).toContain(expectedDedupeKey);
  });

  it("does NOT kill reminders for a different occurrence (LIKE prefix is occurrence-specific)", async () => {
    const occurrenceStart = new Date("2024-06-03T10:00:00Z");
    const differentOccurrenceKey = `calendar:reminder:${EVENT_ID}:2024-06-10T10:00:00.000Z%`;

    const insertChain = makeInsertChain([{ id: 1 }]);
    const updateChain = makeUpdateChain();

    const tx = {
      // No exception rows: the occurrence-key resolution finds nothing and uses the
      // instant supplied, which is what these fixtures assume. The resolution itself is
      // covered by calendar-moved-occurrence-identity.spec.ts.
      select: makeSelectChain([]),
      insert: insertChain.insert,
      update: updateChain.update,
    };

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
        },
      },
      select: makeSelectChain([{ createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }]),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown[]>) => cb(tx)),
    };

    const svc = makeService(db);
    await svc.cancelOccurrence(ORG, USER, EVENT_ID, occurrenceStart.toISOString());

    const whereCond = updateChain.outboxWhereCalls()[0];
    const { params } = renderCond(whereCond);
    expect(params).not.toContain(differentOccurrenceKey);
  });

  it("returns null and skips the transaction when the caller is not the event owner", async () => {
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      select: makeSelectChain([]),
      transaction: jest.fn(),
    };

    const svc = makeService(db);
    const result = await svc.cancelOccurrence(ORG, USER, EVENT_ID, new Date().toISOString());

    expect(result).toBeNull();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("upsertOccurrenceException — kills old PENDING reminder when modifiedStart changes", () => {
  beforeEach(() => jest.resetAllMocks());

  it("marks the original occurrence dedupeKey DEAD when modifiedStart is provided (LIKE prefix covers per-attendee keys)", async () => {
    const occurrenceStart = new Date("2024-06-03T10:00:00Z");
    const modifiedStart = "2024-06-03T14:00:00.000Z";
    const expectedKilledKey = `calendar:reminder:${EVENT_ID}:${occurrenceStart.toISOString()}%`;

    const insertChain = makeInsertChain([{ id: 2, eventId: EVENT_ID }]);
    const updateChain = makeUpdateChain();

    const tx = {
      // No exception rows: the occurrence-key resolution finds nothing and uses the
      // instant supplied, which is what these fixtures assume. The resolution itself is
      // covered by calendar-moved-occurrence-identity.spec.ts.
      select: makeSelectChain([]),
      insert: insertChain.insert,
      update: updateChain.update,
    };

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
        },
      },
      select: makeSelectChain([{ createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }]),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown[]>) => cb(tx)),
    };

    const svc = makeService(db);
    await svc.upsertOccurrenceException(ORG, USER, EVENT_ID, occurrenceStart.toISOString(), {
      modifiedStart,
      modifiedEnd: "2024-06-03T15:00:00.000Z",
    });

    expect(outboxUpdates(updateChain)).toHaveLength(1);
    expect(updateChain.set).toHaveBeenCalledWith({ state: "DEAD" });

    const whereCond = updateChain.outboxWhereCalls()[0];
    const { params } = renderCond(whereCond);
    expect(params).toContain(ORG);
    expect(params).toContain("PENDING");
    expect(params).toContain(expectedKilledKey);
  });

  it("does NOT kill any reminder when modifiedStart is absent (title-only edit)", async () => {
    const occurrenceStart = new Date("2024-06-03T10:00:00Z");

    const insertChain = makeInsertChain([{ id: 3 }]);
    const updateChain = makeUpdateChain();

    const tx = {
      // No exception rows: the occurrence-key resolution finds nothing and uses the
      // instant supplied, which is what these fixtures assume. The resolution itself is
      // covered by calendar-moved-occurrence-identity.spec.ts.
      select: makeSelectChain([]),
      insert: insertChain.insert,
      update: updateChain.update,
    };

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
        },
      },
      select: makeSelectChain([{ createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }]),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown[]>) => cb(tx)),
    };

    const svc = makeService(db);
    await svc.upsertOccurrenceException(ORG, USER, EVENT_ID, occurrenceStart.toISOString(), {
      modifiedTitle: "Renamed occurrence",
    });

    expect(outboxUpdates(updateChain)).toEqual([]);
  });
});

describe("updateAttendeesInTx — deletes PENDING reminders when attendees are removed", () => {
  beforeEach(() => jest.resetAllMocks());

  it("deletes pending reminder rows for the event when at least one attendee is removed", async () => {
    const ALICE = "user-alice";
    const BOB = "user-bob";

    let selectCallIdx = 0;

    const deleteWhere = jest.fn().mockResolvedValue([]);
    const deletedTables: unknown[] = [];

    const updateSet = jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([]),
    });

    const tx = {
      select: jest.fn().mockImplementation(() => {
        const idx = selectCallIdx++;
        if (idx === 0) {
          const where = jest.fn().mockResolvedValue([{ userId: ALICE }, { userId: BOB }]);
          const innerJoin = jest.fn().mockReturnValue({ where });
          const from = jest.fn().mockReturnValue({ where, innerJoin });
          return { from };
        }
        const where = jest.fn().mockResolvedValue([{ id: 20, userId: ALICE }]);
        const from = jest.fn().mockReturnValue({ where });
        return { from };
      }),
      delete: jest.fn().mockImplementation((table: unknown) => {
        deletedTables.push(table);
        return { where: deleteWhere };
      }),
      update: jest.fn().mockReturnValue({ set: updateSet }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockResolvedValue([]),
        }),
      }),
    };

    await updateAttendeesInTx(
      tx as unknown as Parameters<typeof updateAttendeesInTx>[0],
      ORG,
      EVENT_ID,
      [ALICE],
      "actor-user-id",
    );

    expect(tx.delete).toHaveBeenCalledTimes(2);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ reminder15MinSent: false });

    const lastDeleteWhereCond = deleteWhere.mock.calls[1]?.[0];
    const { params, sql: sqlStr } = renderCond(lastDeleteWhereCond);
    expect(params).toContain(ORG);
    expect(params).toContain("PENDING");
    expect(sqlStr).toContain("like");
    expect(params.some((p) => typeof p === "string" && p.startsWith(`calendar:reminder:${EVENT_ID}:`))).toBe(true);
  });

  it("does NOT delete any pending reminders when no attendees are removed (only additions)", async () => {
    const ALICE = "user-alice";
    const BOB = "user-bob";

    let selectCallIdx = 0;

    const deleteWhere = jest.fn().mockResolvedValue([]);

    const tx = {
      select: jest.fn().mockImplementation(() => {
        const idx = selectCallIdx++;
        if (idx === 0) {
          const where = jest.fn().mockResolvedValue([{ userId: ALICE }]);
          const innerJoin = jest.fn().mockReturnValue({ where });
          const from = jest.fn().mockReturnValue({ where, innerJoin });
          return { from };
        }
        const where = jest.fn().mockResolvedValue([
          { id: 20, userId: ALICE },
          { id: 21, userId: BOB },
        ]);
        const from = jest.fn().mockReturnValue({ where });
        return { from };
      }),
      delete: jest.fn().mockImplementation(() => ({ where: deleteWhere })),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockResolvedValue([]),
        }),
      }),
    };

    await updateAttendeesInTx(
      tx as unknown as Parameters<typeof updateAttendeesInTx>[0],
      ORG,
      EVENT_ID,
      [ALICE, BOB],
      "actor-user-id",
    );

    expect(tx.delete).toHaveBeenCalledTimes(1);
  });
});

describe("CalendarService.updateEvent — series update does NOT delete calendarEventExceptions", () => {
  beforeEach(() => jest.resetAllMocks());

  it("updating a recurring event's rrule never calls delete on calendarEventExceptions", async () => {
    const deletedTables: unknown[] = [];
    const updateWhere = jest.fn().mockResolvedValue([]);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });

    const tx = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
        },
      },
      update: jest.fn().mockReturnValue({ set: updateSet }),
      delete: jest.fn().mockImplementation((table: unknown) => {
        deletedTables.push(table);
        return { where: jest.fn().mockResolvedValue([]) };
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockResolvedValue([]),
          onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };

    const updatedRow = { id: EVENT_ID, orgId: ORG, title: "Updated", integrationConnectionId: null, externalEventId: null };

    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
        update: jest.fn().mockImplementation(() => {
          const returning = jest.fn().mockResolvedValue([updatedRow]);
          const where = jest.fn().mockReturnValue({ returning });
          const set = jest.fn().mockReturnValue({ where });
          return { set };
        }),
        delete: jest.fn().mockImplementation((table: unknown) => {
          deletedTables.push(table);
          return { where: jest.fn().mockResolvedValue([]) };
        }),
        query: {
          organizationMembers: {
            findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
          },
        },
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue([]),
          }),
        }),
      })),
    } as unknown as Db;

    const svc = makeService(db);
    await svc.updateEvent(ORG, USER, EVENT_ID, { rrule: "FREQ=WEEKLY;BYDAY=TU" });

    const { calendarEventExceptions } = await import("../../db/schema");
    const deletedCalExceptions = deletedTables.some((t) => t === calendarEventExceptions);
    expect(deletedCalExceptions).toBe(false);
  });

  it("BITE PROOF: the delete spy IS invoked when attendees are removed (confirming the spy works)", async () => {
    const deletedTables: unknown[] = [];

    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
        query: {
          organizationMembers: {
            findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
          },
        },
        select: jest.fn().mockImplementation(() => {
          const where = jest.fn().mockResolvedValue([{ userId: "user-removed" }]);
          const innerJoin = jest.fn().mockReturnValue({ where });
          const from = jest.fn().mockReturnValue({ where, innerJoin });
          return { from };
        }),
        update: jest.fn().mockImplementation(() => {
          const returning = jest.fn().mockResolvedValue([{ id: EVENT_ID, orgId: ORG, title: "T", integrationConnectionId: null, externalEventId: null }]);
          const where = jest.fn().mockReturnValue({ returning });
          const set = jest.fn().mockReturnValue({ where });
          return { set };
        }),
        delete: jest.fn().mockImplementation((table: unknown) => {
          deletedTables.push(table);
          return { where: jest.fn().mockResolvedValue([]) };
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue([]),
          }),
        }),
      })),
    } as unknown as Db;

    const svc = makeService(db);
    await svc.updateEvent(ORG, USER, EVENT_ID, { attendeeIds: [] });

    expect(deletedTables.length).toBeGreaterThan(0);
  });
});

describe("exportEvents — visibility filter applied to export query", () => {
  beforeEach(() => jest.resetAllMocks());

  it("excludes private events the caller neither created nor attends", async () => {
    const CALLER_MEMBERSHIP_ID = 77;

    const exportRow = (id: number, title: string, visibility: string) => ({
      id,
      title,
      visibility,
      startDate: new Date("2024-06-10T09:00:00Z"),
      endDate: new Date("2024-06-10T09:30:00Z"),
      allDay: false,
      timezone: "UTC",
      rrule: null,
      recurrenceEnd: null,
      category: "general",
      location: null,
      description: null,
      color: null,
    });

    const mockRows = [
      exportRow(1, "Team event", "org"),
      exportRow(2, "Private event", "private"),
    ];

    const capturedWhereArgs: unknown[] = [];

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: CALLER_MEMBERSHIP_ID }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((cond) => {
            capturedWhereArgs.push(cond);
            return {
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue(mockRows),
              }),
            };
          }),
        }),
      }),
    };

    const svc = makeService(db);
    await svc.exportEvents(ScopedRead.of(ORG, USER, "all"), new Date("2024-06-01"), new Date("2024-06-30"));

    expect(capturedWhereArgs.length).toBeGreaterThan(0);
    const { params, sql: sqlStr } = renderCond(capturedWhereArgs[0]);

    expect(params).toContain(ORG);
    expect(params).toContain("org");
    expect(params).toContain(CALLER_MEMBERSHIP_ID);
    expect(sqlStr).toContain("is not null");
  });

  it("applies org_id scope to membership lookup before computing visibility", async () => {
    const memberFindFirst = jest.fn().mockResolvedValue({ id: 5 });

    const db = {
      query: {
        organizationMembers: { findFirst: memberFindFirst },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    };

    const svc = makeService(db);
    await svc.exportEvents(ScopedRead.of(ORG, USER, "all"), new Date("2024-06-01"), new Date("2024-06-30"));

    const call = memberFindFirst.mock.calls[0]?.[0] as { where?: unknown; columns?: unknown };
    expect(call).toBeDefined();
    const { params: membershipParams } = renderCond(call.where);
    expect(membershipParams).toContain(ORG);
    expect(membershipParams).toContain(USER);
    expect(membershipParams).toContain("ACTIVE");
  });
});
