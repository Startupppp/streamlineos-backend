jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { getTableConfig } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { eventAttendees } from "../../db/schema/common/calendar-events";
import { CalendarAttendeesService } from "./calendar-attendees.service";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();
function renderCond(cond: unknown) {
  return dialect.sqlToQuery(cond as SQL);
}

const ORG = "org-membership-keyed";
const USER = "user-test";
const MEMBER_ID = 88;
const EVENT_ID = 200;

describe("eventAttendees schema — membership-keyed, no user_id", () => {
  it("eventAttendees table has a membership_id column", () => {
    const cfg = getTableConfig(eventAttendees);
    const col = cfg.columns.find((c) => c.name === "membership_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
  });

  it("eventAttendees table has NO user_id column — user identity resolved through membership", () => {
    const cfg = getTableConfig(eventAttendees);
    const userIdCol = cfg.columns.find((c) => c.name === "user_id");
    expect(userIdCol).toBeUndefined();
  });

  it("BITE PROOF: membership_id column IS found — absence test above bites when user_id is looked up as membership_id", () => {
    const cfg = getTableConfig(eventAttendees);
    const col = cfg.columns.find((c) => c.name === "membership_id");
    expect(col).toBeDefined();
  });

  it("fk_event_attendees_org_membership composite FK is defined", () => {
    const cfg = getTableConfig(eventAttendees);
    const fk = cfg.foreignKeys.find((f) => f.getName() === "fk_event_attendees_org_membership");
    expect(fk).toBeDefined();
    const fkCols = fk!.reference().columns.map((c) => c.name);
    expect(fkCols).toContain("org_id");
    expect(fkCols).toContain("membership_id");
  });

  it("fk_event_attendees_org_membership onDelete is cascade — attendee row removed when membership row is hard-deleted", () => {
    const cfg = getTableConfig(eventAttendees);
    const fk = cfg.foreignKeys.find((f) => f.getName() === "fk_event_attendees_org_membership");
    expect(fk).toBeDefined();
    const fkAsAny = fk as unknown as { onDelete?: string };
    expect(fkAsAny.onDelete).toBe("cascade");
  });

  it("BITE PROOF: onDelete is cascade (not restrict, not set null, not no action) — wrong value fails the gate", () => {
    const cfg = getTableConfig(eventAttendees);
    const fk = cfg.foreignKeys.find((f) => f.getName() === "fk_event_attendees_org_membership");
    expect(fk).toBeDefined();
    const fkAsAny = fk as unknown as { onDelete?: string };
    expect(fkAsAny.onDelete).not.toBe("restrict");
    expect(fkAsAny.onDelete).not.toBe("set null");
    expect(fkAsAny.onDelete).not.toBe("no action");
  });

  it("fk_event_attendees_org_event composite FK has CASCADE onDelete — attendee removed when event is deleted", () => {
    const cfg = getTableConfig(eventAttendees);
    const fk = cfg.foreignKeys.find((f) => f.getName() === "fk_event_attendees_org_event");
    expect(fk).toBeDefined();
    const fkAsAny = fk as unknown as { onDelete?: string };
    expect(fkAsAny.onDelete).toBe("cascade");
  });

  it("event_attendees_event_membership_unique covers org_id, event_id, membership_id — composite tenant-safe uniqueness", () => {
    const cfg = getTableConfig(eventAttendees);
    const uq = cfg.uniqueConstraints.find(
      (u) => u.name === "event_attendees_event_membership_unique",
    );
    expect(uq).toBeDefined();
    const cols = uq!.columns.map((c) => c.name);
    expect(cols).toContain("org_id");
    expect(cols).toContain("event_id");
    expect(cols).toContain("membership_id");
  });
});

describe("CalendarAttendeesService.rsvp — conflict target includes org_id (tenant-safe)", () => {
  beforeEach(() => jest.resetAllMocks());

  function makeDb(memberRow: { id: number } | null): Db {
    const returning = jest.fn().mockResolvedValue([{ id: 1, status: "accepted", orgId: ORG, eventId: EVENT_ID, membershipId: MEMBER_ID }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const limit = jest.fn().mockResolvedValue(memberRow ? [{ id: EVENT_ID }] : []);
    const where = jest.fn().mockReturnValue({ limit });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    return {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(memberRow),
        },
      },
      select: jest.fn().mockReturnValue({ from }),
      insert: jest.fn().mockReturnValue({ values }),
    } as unknown as Db;
  }

  it("rsvp calls onConflictDoUpdate (not onConflictDoNothing) — upsert path for re-RSVP", async () => {
    const db = makeDb({ id: MEMBER_ID });
    const svc = new CalendarAttendeesService(db);
    await svc.rsvp(ORG, USER, EVENT_ID, { status: "accepted" });
    const insertMock = db.insert as jest.Mock;
    expect(insertMock).toHaveBeenCalledTimes(1);
    const valuesChain = insertMock.mock.results[0]?.value as { values: jest.Mock };
    expect(valuesChain.values).toHaveBeenCalledTimes(1);
    const valuesResult = valuesChain.values.mock.results[0]?.value as { onConflictDoUpdate: jest.Mock };
    expect(valuesResult.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    const conflictArg = valuesResult.onConflictDoUpdate.mock.calls[0]?.[0] as {
      target?: unknown[];
    };
    expect(conflictArg).toBeDefined();
    expect(Array.isArray(conflictArg?.target)).toBe(true);
  });

  it("conflict target columns include org_id — prevents cross-tenant conflict bypass", async () => {
    const capturedConflictTarget: unknown[] = [];
    const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
    const onConflictDoUpdate = jest.fn().mockImplementation((arg: { target?: unknown[] }) => {
      if (Array.isArray(arg.target)) capturedConflictTarget.push(...arg.target);
      return { returning };
    });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const limit = jest.fn().mockResolvedValue([{ id: EVENT_ID }]);
    const where = jest.fn().mockReturnValue({ limit });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    const db: Db = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }) } },
      select: jest.fn().mockReturnValue({ from }),
      insert: jest.fn().mockReturnValue({ values }),
    } as unknown as Db;

    const svc = new CalendarAttendeesService(db);
    await svc.rsvp(ORG, USER, EVENT_ID, { status: "accepted" });

    const colNames = capturedConflictTarget.map((c) => {
      const asAny = c as { name?: string };
      return asAny.name ?? "";
    });
    expect(colNames).toContain("org_id");
    expect(colNames).toContain("membership_id");
    expect(colNames).toContain("event_id");
  });

  it("BITE PROOF: with null memberRow, rsvp returns null and does NOT call insert", async () => {
    const db = makeDb(null);
    const svc = new CalendarAttendeesService(db);
    const result = await svc.rsvp(ORG, USER, EVENT_ID, { status: "accepted" });
    expect(result).toBeNull();
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
  });
});

describe("CalendarAttendeesService.listAttendees — membership join, not user_id join", () => {
  beforeEach(() => jest.resetAllMocks());

  it("listAttendees resolves membership from orgId before joining — org-scoped lookup", async () => {
    const capturedFindFirstArgs: unknown[] = [];

    const db: Db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockImplementation((arg: unknown) => {
            capturedFindFirstArgs.push(arg);
            return Promise.resolve(null);
          }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new CalendarAttendeesService(db);
    await svc.listAttendees(ORG, USER, EVENT_ID);

    expect(capturedFindFirstArgs.length).toBeGreaterThan(0);
    const arg = capturedFindFirstArgs[0] as { where?: unknown };
    const { params } = renderCond(arg?.where);
    expect(params).toContain(ORG);
    expect(params).toContain(USER);
    expect(params).toContain("ACTIVE");
  });

  it("BITE PROOF: membership lookup is called even when event does not exist (gate fires before the join)", async () => {
    const findFirstSpy = jest.fn().mockResolvedValue({ id: MEMBER_ID });

    const db: Db = {
      query: {
        organizationMembers: {
          findFirst: findFirstSpy,
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new CalendarAttendeesService(db);
    const result = await svc.listAttendees(ORG, USER, EVENT_ID);
    expect(findFirstSpy).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});

describe("eventAttendees schema — departed actor history retention via RESTRICT on creator FK", () => {
  it("calendar_events.fk_calendar_events_org_creator_membership does NOT cascade delete — history survives membership INACTIVE state", () => {
    const { calendarEvents } = jest.requireActual<typeof import("../../db/schema/common/calendar-events")>(
      "../../db/schema/common/calendar-events",
    );
    const cfg = getTableConfig(calendarEvents);
    const fk = cfg.foreignKeys.find(
      (f) => f.getName() === "fk_calendar_events_org_creator_membership",
    );
    expect(fk).toBeDefined();
    const fkAsAny = fk as unknown as { onDelete?: string };
    expect(fkAsAny.onDelete).not.toBe("cascade");
    expect(fkAsAny.onDelete).not.toBe("set null");
  });

  it("BITE PROOF: the FK IS found — the test above bites only if the FK is wrongly configured", () => {
    const { calendarEvents } = jest.requireActual<typeof import("../../db/schema/common/calendar-events")>(
      "../../db/schema/common/calendar-events",
    );
    const cfg = getTableConfig(calendarEvents);
    const fk = cfg.foreignKeys.find(
      (f) => f.getName() === "fk_calendar_events_org_creator_membership",
    );
    expect(fk).toBeDefined();
  });
});
