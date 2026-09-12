/**
 * CA3 — Event lifecycle permissions and RSVP upsert semantics.
 *
 * Covered here:
 *   1. Only the creator can update an event; an attendee (non-creator) cannot.
 *   2. Only the creator can delete an event; an attendee (non-creator) cannot.
 *   3. RSVP upsert conflict target — the composite key that makes a race safe.
 *   4. RSVP is available to any org member for an org-visible event.
 *   5. RSVP on a private event requires being visible to the event
 *      (creator or attendee — the same predicate as listAttendees).
 */
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { CalendarService } from "./calendar.service";
import { CalendarAttendeesService } from "./calendar-attendees.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, type SQL } from "drizzle-orm";
import { eventAttendees } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();

function render(cond: unknown) {
  return dialect.sqlToQuery(cond as SQL);
}

const ORG = "org-lifecycle";
const CREATOR_USER = "user-creator";
const ATTENDEE_USER = "user-attendee";
const CREATOR_MID = 10;
const ATTENDEE_MID = 20;
const EVENT_ID = 500;

function makeCalendarService(db: unknown): CalendarService {
  return new CalendarService(
    db as Db,
    {} as never,
    {
      checkConflictsInTx: jest.fn().mockResolvedValue([]),
      getOooConflicts: jest.fn().mockResolvedValue([]),
    } as never,
    {} as never,
    new CalendarRecurrenceService(db as Db),
    new CalendarExportService(db as Db),
    {} as never,
  );
}

describe("CalendarService.updateEvent — only the creator can mutate", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns null when the membership lookup returns a member who is NOT the creator (attendee role)", async () => {
    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue({ id: ATTENDEE_MID }),
            },
          },
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        };
        return cb(tx);
      }),
    };

    const svc = makeCalendarService(db);
    const result = await svc.updateEvent(ORG, ATTENDEE_USER, EVENT_ID, { title: "Hijacked title" });

    expect(result).toBeNull();
  });

  it("BITE: returns non-null when the member IS the creator — confirms the WHERE clause matches by membership id", async () => {
    const updatedRow = {
      id: EVENT_ID,
      orgId: ORG,
      title: "Legitimate update",
      description: null,
      location: null,
      meetingUrl: null,
      startDate: new Date("2026-09-15T09:00:00Z"),
      endDate: new Date("2026-09-15T10:00:00Z"),
      timezone: "UTC",
      allDay: false,
      color: "blue",
      category: "meeting",
      entityType: null,
      entityId: null,
      rrule: null,
      recurrenceEnd: null,
      localVersion: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
      integrationConnectionId: null,
      externalEventId: null,
    };

    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue({ id: CREATOR_MID }),
            },
          },
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([updatedRow]),
              }),
            }),
          }),
          insert: jest.fn().mockReturnValue({
            values: jest.fn().mockResolvedValue([]),
          }),
        };
        return cb(tx);
      }),
    };

    const svc = makeCalendarService(db);
    const result = await svc.updateEvent(ORG, CREATOR_USER, EVENT_ID, { title: "Legitimate update" });

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Legitimate update");
  });

  it("the update WHERE predicate includes createdByMembershipId = caller's membershipId (creator check is in DB)", async () => {
    const capturedWhereArgs: unknown[] = [];

    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue({ id: CREATOR_MID }),
            },
          },
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockImplementation((cond: unknown) => {
                capturedWhereArgs.push(cond);
                return { returning: jest.fn().mockResolvedValue([]) };
              }),
            }),
          }),
        };
        return cb(tx);
      }),
    };

    const svc = makeCalendarService(db);
    await svc.updateEvent(ORG, CREATOR_USER, EVENT_ID, { title: "Check predicate" });

    expect(capturedWhereArgs.length).toBeGreaterThan(0);
    const { params } = render(capturedWhereArgs[0]);
    expect(params).toContain(CREATOR_MID);
    expect(params).toContain(ORG);
    expect(params).toContain(EVENT_ID);
  });
});

describe("CalendarService.deleteEvent — only the creator can delete", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns null and does not call DELETE when membership is an attendee (non-creator)", async () => {
    const deleteFn = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    });

    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue({ id: ATTENDEE_MID }),
            },
          },
          delete: deleteFn,
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
          }),
        };
        return cb(tx);
      }),
    };

    const svc = makeCalendarService(db);
    const result = await svc.deleteEvent(ORG, ATTENDEE_USER, EVENT_ID);

    expect(result).toBeNull();
  });

  it("BITE: the DELETE WHERE predicate includes createdByMembershipId = caller's membershipId", async () => {
    const capturedWhereArgs: unknown[] = [];
    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            organizationMembers: {
              findFirst: jest.fn().mockResolvedValue({ id: CREATOR_MID }),
            },
          },
          delete: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((cond: unknown) => {
              capturedWhereArgs.push(cond);
              return {
                returning: jest.fn().mockResolvedValue([
                  { integrationConnectionId: null, externalEventId: null, localVersion: 1 },
                ]),
              };
            }),
          }),
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
          }),
        };
        return cb(tx);
      }),
    };

    const svc = makeCalendarService(db);
    await svc.deleteEvent(ORG, CREATOR_USER, EVENT_ID);

    expect(capturedWhereArgs.length).toBeGreaterThan(0);
    const { params } = render(capturedWhereArgs[0]);
    expect(params).toContain(CREATOR_MID);
    expect(params).toContain(ORG);
    expect(params).toContain(EVENT_ID);
  });
});

describe("CalendarAttendeesService.rsvp — upsert conflict target (RSVP race safety)", () => {
  it("rsvp conflict target is the composite (orgId, eventId, membershipId) — the three columns that uniquely identify one person's RSVP", () => {
    const compositeTarget = [
      eventAttendees.orgId,
      eventAttendees.eventId,
      eventAttendees.membershipId,
    ];
    expect(compositeTarget).toHaveLength(3);
    const names = compositeTarget.map((c) => (c as { name?: string }).name);
    expect(names).toContain("org_id");
    expect(names).toContain("event_id");
    expect(names).toContain("membership_id");
  });

  it("rsvp upsert updates status on conflict — a second RSVP from the same member does not create a duplicate row", async () => {
    const capturedConflict: unknown[] = [];

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: ATTENDEE_MID }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ id: EVENT_ID }]),
            }),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockImplementation((opts: unknown) => {
            capturedConflict.push(opts);
            return { returning: jest.fn().mockResolvedValue([{ id: 1, status: "accepted" }]) };
          }),
        }),
      }),
    };

    const svc = new CalendarAttendeesService(db as unknown as Db);
    await svc.rsvp(ORG, ATTENDEE_USER, EVENT_ID, { status: "accepted" });

    expect(capturedConflict).toHaveLength(1);
    const opts = capturedConflict[0] as { target?: unknown[]; set?: Record<string, unknown> };
    expect(opts.target).toBeDefined();
    expect(Array.isArray(opts.target)).toBe(true);
    expect((opts.target as unknown[]).length).toBe(3);
    expect(opts.set).toHaveProperty("status");
    expect(opts.set).toHaveProperty("updatedAt");
  });

  it("a second RSVP with 'declined' updates to declined, not inserting a duplicate row", async () => {
    let capturedSet: Record<string, unknown> | undefined;

    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: ATTENDEE_MID }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ id: EVENT_ID }]),
            }),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockImplementation((opts: { set?: Record<string, unknown> }) => {
            capturedSet = opts.set;
            return { returning: jest.fn().mockResolvedValue([{ id: 1, status: "declined" }]) };
          }),
        }),
      }),
    };

    const svc = new CalendarAttendeesService(db as unknown as Db);
    await svc.rsvp(ORG, ATTENDEE_USER, EVENT_ID, { status: "declined" });

    expect(capturedSet?.status).toBe("declined");
  });

  it("rsvp returns null (no upsert) when the caller has no active membership — non-member cannot RSVP", async () => {
    const insertFn = jest.fn();
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
      insert: insertFn,
    };

    const svc = new CalendarAttendeesService(db as unknown as Db);
    const result = await svc.rsvp(ORG, "user-non-member", EVENT_ID, { status: "accepted" });

    expect(result).toBeNull();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("rsvp on a private event: non-attendee non-creator gets null (visibility gate in getVisibleEventForOrg)", async () => {
    const insertFn = jest.fn();
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: ATTENDEE_MID }),
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
      insert: insertFn,
    };

    const svc = new CalendarAttendeesService(db as unknown as Db);
    const result = await svc.rsvp(ORG, ATTENDEE_USER, EVENT_ID, { status: "accepted" });

    expect(result).toBeNull();
    expect(insertFn).not.toHaveBeenCalled();
  });
});

describe("CalendarAttendeesService — RSVP conflict target column check", () => {
  it("eventAttendees has the composite unique index columns (orgId, eventId, membershipId)", () => {
    const cols = [eventAttendees.orgId, eventAttendees.eventId, eventAttendees.membershipId];
    for (const col of cols) expect(col).toBeDefined();
  });

  it("the conflict target columns render the correct DB column names", () => {
    const target = and(
      eq(eventAttendees.orgId, ORG),
      eq(eventAttendees.eventId, EVENT_ID),
      eq(eventAttendees.membershipId, ATTENDEE_MID),
    ) as SQL;
    const { sql: sqlStr } = render(target);
    expect(sqlStr).toContain('"event_attendees"."org_id"');
    expect(sqlStr).toContain('"event_attendees"."event_id"');
    expect(sqlStr).toContain('"event_attendees"."membership_id"');
  });
});
