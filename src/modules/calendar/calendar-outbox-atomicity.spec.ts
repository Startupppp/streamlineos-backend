jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CalendarService } from "./calendar.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();
function renderCond(cond: unknown) {
  return dialect.sqlToQuery(cond as SQL);
}

const ORG = "org-atomicity-spec";
const CREATOR = "user-creator";
const ATTENDEE = "user-attendee";
const MEMBER_ID = 5;
const ATTENDEE_MEMBER_ID = 20;
const EVENT_ID = 101;

function makeServiceWith(db: unknown, conflictOverride?: unknown): CalendarService {
  const conflict = conflictOverride ?? {
    checkConflictsInTx: jest.fn().mockResolvedValue([]),
    getOooConflicts: jest.fn().mockResolvedValue([]),
  };
  const recurrence = new CalendarRecurrenceService(db as Db);
  const calendarExport = new CalendarExportService(db as Db);
  return new CalendarService(
    db as Db,
    {} as never,
    conflict as never,
    {} as never,
    recurrence,
    calendarExport,
  );
}

describe("CalendarService.createEvent — invitation outbox write is atomic with the event insert", () => {
  beforeEach(() => jest.resetAllMocks());

  it("BITE: notificationOutbox insert appears on tx (inside transaction), never on db directly after commit", async () => {
    const txInsertedEventKeys: string[] = [];
    const dbInsertedEventKeys: string[] = [];
    let txInsertIdx = 0;

    const eventRow = {
      id: EVENT_ID,
      title: "Team meeting",
      startDate: new Date("2024-07-01T10:00:00Z"),
      endDate: new Date("2024-07-01T11:00:00Z"),
      updatedAt: new Date(),
      integrationConnectionId: null,
      externalEventId: null,
    };

    const tx = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ id: ATTENDEE_MEMBER_ID, userId: ATTENDEE }]),
        }),
      }),
      insert: jest.fn().mockImplementation((_table: unknown) => {
        const myIdx = txInsertIdx++;
        return {
          values: jest.fn().mockImplementation((v: unknown) => {
            const val = v as Record<string, unknown>;
            if (typeof val.eventKey === "string") {
              txInsertedEventKeys.push(val.eventKey);
            }
            const rows = myIdx === 0 ? [eventRow] : [];
            return {
              returning: jest.fn().mockResolvedValue(rows),
              onConflictDoNothing: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue(rows),
              }),
            };
          }),
        };
      }),
    };

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ userId: ATTENDEE }]),
        }),
      }),
      insert: jest.fn().mockImplementation((_table: unknown) => ({
        values: jest.fn().mockImplementation((v: unknown) => {
          const val = v as Record<string, unknown>;
          if (typeof val.eventKey === "string") {
            dbInsertedEventKeys.push(val.eventKey);
          }
          return {
            returning: jest.fn().mockResolvedValue([]),
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          };
        }),
      })),
      transaction: jest.fn().mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = makeServiceWith(db);

    await svc.createEvent(ORG, CREATOR, {
      title: "Team meeting",
      startDate: "2024-07-01T10:00:00.000Z",
      endDate: "2024-07-01T11:00:00.000Z",
      timezone: "UTC",
      allDay: false,
      category: "meeting",
      attendeeIds: [ATTENDEE],
    });

    expect(txInsertedEventKeys).toContain("calendar.event.invited");
    expect(dbInsertedEventKeys).not.toContain("calendar.event.invited");
  });
});

describe("CalendarService.updateEvent — timezone change supersedes pending reminders in the same tx", () => {
  beforeEach(() => jest.resetAllMocks());

  it("BITE: changing the timezone kills pending reminder rows in the same transaction as the event update", async () => {
    let txUpdateIdx = 0;
    const txUpdateCaptures: Array<{ setArg: unknown; whereArg: unknown }> = [];

    const updatedEvent = {
      id: EVENT_ID,
      title: "Existing meeting",
      startDate: new Date("2024-07-01T10:00:00Z"),
      endDate: new Date("2024-07-01T11:00:00Z"),
      timezone: "America/Chicago",
      reminder15MinSent: false,
      integrationConnectionId: null,
      externalEventId: null,
      updatedAt: new Date(),
    };

    const tx = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
        },
      },
      update: jest.fn().mockImplementation((_table: unknown) => {
        const myIdx = txUpdateIdx++;
        return {
          set: jest.fn().mockImplementation((setArg: unknown) => ({
            where: jest.fn().mockImplementation((whereArg: unknown) => {
              txUpdateCaptures.push({ setArg, whereArg });
              const resolveValue = myIdx === 0 ? [updatedEvent] : [];
              const p = Object.assign(Promise.resolve(resolveValue), {
                returning: jest.fn().mockResolvedValue(resolveValue),
              });
              return p;
            }),
          })),
        };
      }),
    };

    const db = {
      transaction: jest.fn().mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const svc = makeServiceWith(db);

    const result = await svc.updateEvent(ORG, CREATOR, EVENT_ID, {
      timezone: "America/Chicago",
    });

    expect(result).not.toBeNull();
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(txUpdateCaptures).toHaveLength(2);

    const reminderKill = txUpdateCaptures.find(
      (c) => (c.setArg as Record<string, unknown>).state === "DEAD",
    );
    expect(reminderKill).toBeDefined();

    const { params } = renderCond(reminderKill!.whereArg);
    expect(params).toContain(ORG);
    expect(params).toContain("PENDING");
  });
});
