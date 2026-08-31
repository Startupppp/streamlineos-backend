jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CalendarService } from "./calendar.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";
import type { Db } from "../../db/drizzle.module";

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

function makeUpdateChain() {
  const where = jest.fn().mockResolvedValue([]);
  const set = jest.fn().mockReturnValue({ where });
  return { update: jest.fn().mockReturnValue({ set }), set, where };
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
  return new CalendarService(db as Db, {} as never, {} as never, {} as never, {} as never, recurrence, calendarExport);
}

describe("cancelOccurrence — kills PENDING outbox reminder for the specific occurrence", () => {
  beforeEach(() => jest.resetAllMocks());

  it("marks the matching occurrence dedupeKey DEAD in the same transaction", async () => {
    const occurrenceStart = new Date("2024-06-03T10:00:00Z");
    const expectedDedupeKey = `calendar:reminder:${EVENT_ID}:${occurrenceStart.toISOString()}`;

    const insertChain = makeInsertChain([{ id: 1, eventId: EVENT_ID }]);
    const updateChain = makeUpdateChain();

    const tx = {
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
    expect(updateChain.update).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith({ state: "DEAD" });

    const whereCond = updateChain.where.mock.calls[0]?.[0];
    const { params } = renderCond(whereCond);
    expect(params).toContain(ORG);
    expect(params).toContain("PENDING");
    expect(params).toContain(expectedDedupeKey);
  });

  it("does NOT kill reminders for a different occurrence (dedupeKey is occurrence-specific)", async () => {
    const occurrenceStart = new Date("2024-06-03T10:00:00Z");
    const differentOccurrenceKey = `calendar:reminder:${EVENT_ID}:2024-06-10T10:00:00.000Z`;

    const insertChain = makeInsertChain([{ id: 1 }]);
    const updateChain = makeUpdateChain();

    const tx = {
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

    const whereCond = updateChain.where.mock.calls[0]?.[0];
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

  it("marks the original occurrence dedupeKey DEAD when modifiedStart is provided", async () => {
    const occurrenceStart = new Date("2024-06-03T10:00:00Z");
    const modifiedStart = "2024-06-03T14:00:00.000Z";
    const expectedKilledKey = `calendar:reminder:${EVENT_ID}:${occurrenceStart.toISOString()}`;

    const insertChain = makeInsertChain([{ id: 2, eventId: EVENT_ID }]);
    const updateChain = makeUpdateChain();

    const tx = {
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

    expect(updateChain.update).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith({ state: "DEAD" });

    const whereCond = updateChain.where.mock.calls[0]?.[0];
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

    expect(updateChain.update).not.toHaveBeenCalled();
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
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockResolvedValue([]),
        }),
      }),
    };

    const db = {} as unknown as Db;
    const svc = makeService(db);
    await (svc as unknown as { updateAttendeesInTx: (...args: unknown[]) => Promise<string[]> })
      .updateAttendeesInTx(tx, ORG, EVENT_ID, [ALICE], "actor-user-id");

    expect(tx.delete).toHaveBeenCalledTimes(2);

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

    const db = {} as unknown as Db;
    const svc = makeService(db);
    await (svc as unknown as { updateAttendeesInTx: (...args: unknown[]) => Promise<string[]> })
      .updateAttendeesInTx(tx, ORG, EVENT_ID, [ALICE, BOB], "actor-user-id");

    expect(tx.delete).toHaveBeenCalledTimes(1);
  });
});

describe("exportEvents — visibility filter applied to export query", () => {
  beforeEach(() => jest.resetAllMocks());

  it("excludes private events the caller neither created nor attends", async () => {
    const CALLER_MEMBERSHIP_ID = 77;

    const mockRows = [
      { id: 1, title: "Team event", visibility: "org" },
      { id: 2, title: "Private event", visibility: "private" },
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
          leftJoin: jest.fn().mockReturnValue({
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
      }),
    };

    const svc = makeService(db);
    await svc.exportEvents(ORG, USER, new Date("2024-06-01"), new Date("2024-06-30"));

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
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      }),
    };

    const svc = makeService(db);
    await svc.exportEvents(ORG, USER, new Date("2024-06-01"), new Date("2024-06-30"));

    const call = memberFindFirst.mock.calls[0]?.[0] as { where?: unknown; columns?: unknown };
    expect(call).toBeDefined();
    const { params: membershipParams } = renderCond(call.where);
    expect(membershipParams).toContain(ORG);
    expect(membershipParams).toContain(USER);
    expect(membershipParams).toContain("ACTIVE");
  });
});
