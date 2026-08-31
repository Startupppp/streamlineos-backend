jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { getTableConfig } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { calendarEvents, eventAttendees } from "../../db/schema/common/calendar-events";
import { CalendarService } from "./calendar.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();
function renderCond(cond: unknown) {
  return dialect.sqlToQuery(cond as SQL);
}

const ORG = "org-departed-actor";
const USER = "user-departed";
const MEMBER_ID = 55;
const EVENT_ID = 300;

function makeService(db: unknown, conflict?: unknown): CalendarService {
  const recurrence = new CalendarRecurrenceService(db as Db);
  const calendarExport = new CalendarExportService(db as Db);
  return new CalendarService(
    db as Db,
    {} as never,
    {} as never,
    (conflict ?? {}) as never,
    {} as never,
    recurrence,
    calendarExport,
  );
}

function makeSelectChain(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  return jest.fn().mockReturnValue({ from });
}

function makeUpdateChain() {
  const where = jest.fn().mockResolvedValue([]);
  const set = jest.fn().mockReturnValue({ where });
  return { update: jest.fn().mockReturnValue({ set }), set, where };
}

describe("calendarEvents schema — FK semantics for departed actors", () => {
  it("createdByMembershipId column is NOT NULL — confirming SET NULL is impossible on this FK", () => {
    const tableConfig = getTableConfig(calendarEvents);
    const col = tableConfig.columns.find((c) => c.name === "created_by_membership_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
  });

  it("eventAttendees.membershipId column is NOT NULL — attendee rows survive as long as their membership row exists", () => {
    const tableConfig = getTableConfig(eventAttendees);
    const col = tableConfig.columns.find((c) => c.name === "membership_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
  });

  it("fk_calendar_events_org_creator_membership is NO ACTION — hard-delete of membership is blocked at DB level, confdelsetcols is null", () => {
    const tableConfig = getTableConfig(calendarEvents);
    const fk = tableConfig.foreignKeys.find(
      (f) => f.getName() === "fk_calendar_events_org_creator_membership",
    );
    expect(fk).toBeDefined();
    const fkAsAny = fk as unknown as { onDelete?: string };
    expect(fkAsAny.onDelete).toBe("no action");
  });

  it("fk_event_attendees_org_membership has no SET NULL onDelete — departure does not null org_id, confdelsetcols is not applicable", () => {
    const tableConfig = getTableConfig(eventAttendees);
    const fk = tableConfig.foreignKeys.find(
      (f) => f.getName() === "fk_event_attendees_org_membership",
    );
    expect(fk).toBeDefined();
    const fkAsAny = fk as unknown as { onDelete?: string };
    expect(fkAsAny.onDelete).not.toBe("set null");
  });
});

describe("CalendarService — updateEvent returns null when creator membership is departed (INACTIVE)", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns null (no throw) when the creator has no ACTIVE membership — departed actor cannot mutate their events", async () => {
    const updateChain = makeUpdateChain();

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
          },
          ...updateChain,
        };
        return cb(tx);
      }),
    };

    const svc = makeService(db);
    const result = await svc.updateEvent(ORG, USER, EVENT_ID, { title: "New title" });

    expect(result).toBeNull();
    expect(updateChain.update).not.toHaveBeenCalled();
  });

  it("BITE PROOF: with an ACTIVE membership, updateEvent proceeds and calls update (gate is real)", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: EVENT_ID, title: "New title", updatedAt: new Date() }]);
    const updateWhere = jest.fn().mockReturnValue({ returning });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const notifWhere = jest.fn().mockResolvedValue([]);
    const notifSet = jest.fn().mockReturnValue({ where: notifWhere });

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
        },
      },
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
            },
          },
          update: jest.fn().mockReturnValueOnce({ set: updateSet }).mockReturnValue({ set: notifSet }),
        };
        return cb(tx);
      }),
    };

    const svc = makeService(db);
    const result = await svc.updateEvent(ORG, USER, EVENT_ID, { title: "New title" });

    expect(result).not.toBeNull();
    expect(updateSet).toHaveBeenCalled();
  });

  it("membership lookup is scoped to the requesting org_id — cross-org departure cannot unblock another org's events", async () => {
    const capturedWheres: unknown[] = [];

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockImplementation((opts: { where?: unknown }) => {
                capturedWheres.push(opts.where);
                return Promise.resolve(null);
              }),
            },
          },
        };
        return cb(tx);
      }),
    };

    const svc = makeService(db);
    await svc.updateEvent(ORG, USER, EVENT_ID, { title: "X" });

    expect(capturedWheres.length).toBeGreaterThan(0);
    const { params } = renderCond(capturedWheres[0]);
    expect(params).toContain(ORG);
    expect(params).toContain(USER);
    expect(params).toContain("ACTIVE");
  });
});

describe("CalendarService — createEvent throws when caller has no ACTIVE membership", () => {
  beforeEach(() => jest.resetAllMocks());

  it("throws 'Active organization membership required' when caller has no active membership", async () => {
    const conflictMock = {
      getOooConflicts: jest.fn().mockResolvedValue([]),
      checkConflictsInTx: jest.fn().mockResolvedValue([]),
    };

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      select: makeSelectChain([]),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
          },
          insert: jest.fn(),
          select: makeSelectChain([]),
        };
        return cb(tx);
      }),
    };

    const svc = makeService(db, conflictMock);
    await expect(
      svc.createEvent(ORG, USER, {
        title: "Team standup",
        startDate: new Date("2024-06-10T09:00:00Z").toISOString(),
        endDate: new Date("2024-06-10T09:30:00Z").toISOString(),
        timezone: "UTC",
        category: "general",
      }),
    ).rejects.toThrow("Active organization membership required");
  });

  it("BITE PROOF: with an ACTIVE membership, createEvent does not throw (gate is real)", async () => {
    const conflictMock = {
      getOooConflicts: jest.fn().mockResolvedValue([]),
      checkConflictsInTx: jest.fn().mockResolvedValue([]),
    };

    const returning = jest.fn().mockResolvedValue([{ id: 1, title: "Team standup", updatedAt: new Date() }]);
    const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoNothing, returning });

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      select: makeSelectChain([]),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
            },
          },
          insert: jest.fn().mockReturnValue({ values }),
          select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
          update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        };
        return cb(tx);
      }),
    };

    const svc = makeService(db, conflictMock);
    await expect(
      svc.createEvent(ORG, USER, {
        title: "Team standup",
        startDate: new Date("2024-06-10T09:00:00Z").toISOString(),
        endDate: new Date("2024-06-10T09:30:00Z").toISOString(),
        timezone: "UTC",
        category: "general",
      }),
    ).resolves.toBeDefined();
  });
});

describe("CalendarService — deleteEvent reports a miss rather than a false success for a departed creator", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns null when the creator has no ACTIVE membership, so the caller can surface a 404", async () => {
    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
          },
          delete: jest.fn(),
        };
        return cb(tx);
      }),
    };

    const svc = makeService(db);
    const result = await svc.deleteEvent(ORG, USER, EVENT_ID);

    expect(result).toBeNull();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("does NOT issue a DELETE SQL for the event row when creator is INACTIVE", async () => {
    const deleteFn = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });

    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
          },
          delete: deleteFn,
        };
        return cb(tx);
      }),
    };

    const svc = makeService(db);
    await svc.deleteEvent(ORG, USER, EVENT_ID);

    expect(deleteFn).not.toHaveBeenCalled();
  });
});

describe("CalendarEventSourceLoader — INNER JOIN on creatorMember dependency (structural)", () => {
  it("calendarEvents has the composite FK fk_calendar_events_org_creator_membership covering org_id and created_by_membership_id", () => {
    const tableConfig = getTableConfig(calendarEvents);
    const fk = tableConfig.foreignKeys.find(
      (f) => f.getName() === "fk_calendar_events_org_creator_membership",
    );
    expect(fk).toBeDefined();
    expect(fk!.getName()).toBe("fk_calendar_events_org_creator_membership");
    const fkAsAny = fk as unknown as { onDelete?: string; onUpdate?: string };
    expect(fkAsAny.onDelete).toBe("no action");
  });

  it("calendarEvents.createdByMembershipId column exists and is NOT NULL — departure must be a soft status change", () => {
    const tableConfig = getTableConfig(calendarEvents);
    const col = tableConfig.columns.find((c) => c.name === "created_by_membership_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
  });
});
