jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { CalendarService } from "./calendar.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";
import type { Db } from "../../db/drizzle.module";
import { getTableColumns } from "drizzle-orm";
import { calendarEvents } from "../../db/schema";
import {
  calendarCreateEventResponseSchema,
  calendarUpdateEventResponseSchema,
} from "./dto/calendar-response.schemas";

/**
 * PRD-C086 / PRD-C088 — the mutate routes return a projection, not the whole row.
 *
 * `createEvent` and `updateEvent` both ended in a bare `.returning()`, which is every
 * column of `calendar_events`. Nine of the 26 are not the caller's business:
 * `createdByMembershipId` and `reminder15MinSent` are internal bookkeeping,
 * `integrationConnectionId` and `externalEventId` name a provider connection, and
 * `agenda`, `postMeetingNotes`, `visibility`, `linkedDealId` and `linkedLeadId` belong
 * to other domains. The browser client declared none of them.
 *
 * The assertion is on the object handed to `.returning()`, because that is where the
 * defect lives: a mock cannot project, so asserting on the mocked row would pass
 * against a bare `.returning()` and prove nothing. Reverting either call site to
 * `.returning()` makes the captured argument `undefined` and fails here.
 */

const ORG = "org-projection-spec";
const ACTOR = "user-actor";
const MEMBER_ID = 7;
const EVENT_ID = 4242;

/** Every column the table declares — the shape a bare `.returning()` hands back. */
const ALL_COLUMNS = Object.keys(getTableColumns(calendarEvents));

/** The 20 the wire is allowed to carry. */
const WIRE_COLUMNS = [
  "id",
  "orgId",
  "title",
  "description",
  "location",
  "meetingUrl",
  "startDate",
  "endDate",
  "timezone",
  "allDay",
  "color",
  "category",
  "entityType",
  "entityId",
  "rrule",
  "recurrenceEnd",
  "localVersion",
  "createdAt",
  "updatedAt",
];

/** Named one by one so a new internal column added later is caught, not absorbed. */
const WITHHELD_COLUMNS = [
  "createdByMembershipId",
  "reminder15MinSent",
  "integrationConnectionId",
  "externalEventId",
  "agenda",
  "postMeetingNotes",
  "visibility",
  "linkedDealId",
  "linkedLeadId",
];

function makeService(db: unknown): CalendarService {
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

function wireRow(): Record<string, unknown> {
  return {
    id: EVENT_ID,
    orgId: ORG,
    title: "Team meeting",
    description: null,
    location: null,
    meetingUrl: null,
    startDate: new Date("2024-07-01T10:00:00Z"),
    endDate: new Date("2024-07-01T11:00:00Z"),
    timezone: "UTC",
    allDay: false,
    color: "blue",
    category: "meeting",
    entityType: null,
    entityId: null,
    rrule: null,
    recurrenceEnd: null,
    localVersion: 1,
    createdAt: new Date("2024-06-01T00:00:00Z"),
    updatedAt: new Date("2024-06-01T00:00:00Z"),
  };
}

describe("calendar_events is a 26-column table, so the projection is worth pinning", () => {
  it("names every column, so a column added later lands in wire or withheld deliberately", () => {
    expect(ALL_COLUMNS.length).toBeGreaterThan(0);
    expect([...WIRE_COLUMNS, ...WITHHELD_COLUMNS].sort()).toEqual([...ALL_COLUMNS].sort());
  });
});

describe("CalendarService.createEvent — returns a projection, never the whole row", () => {
  beforeEach(() => jest.resetAllMocks());

  it("projects exactly the wire columns and withholds the nine internal ones", async () => {
    let returningArg: unknown;
    const tx = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockImplementation((arg: unknown) => {
            returningArg = arg;
            return Promise.resolve([wireRow()]);
          }),
          onConflictDoNothing: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    const db = {
      transaction: jest
        .fn()
        .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    await makeService(db).createEvent(ORG, ACTOR, {
      title: "Team meeting",
      startDate: "2024-07-01T10:00:00.000Z",
      endDate: "2024-07-01T11:00:00.000Z",
      timezone: "UTC",
      allDay: false,
      category: "meeting",
    });

    // A bare `.returning()` passes nothing; that is exactly the defect this pins.
    expect(returningArg).toBeDefined();
    const projected = Object.keys(returningArg as Record<string, unknown>);
    expect(projected.sort()).toEqual([...WIRE_COLUMNS].sort());
    for (const withheld of WITHHELD_COLUMNS) expect(projected).not.toContain(withheld);
  });

  it("the declared @ResponseSchema accepts the body the service builds", async () => {
    const tx = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([wireRow()]),
          onConflictDoNothing: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
    const db = {
      transaction: jest
        .fn()
        .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const result = await makeService(db).createEvent(ORG, ACTOR, {
      title: "Team meeting",
      startDate: "2024-07-01T10:00:00.000Z",
      endDate: "2024-07-01T11:00:00.000Z",
      timezone: "UTC",
      allDay: false,
      category: "meeting",
    });

    expect(calendarCreateEventResponseSchema.safeParse(result).success).toBe(true);
  });
});

describe("CalendarService.updateEvent — reads the sync columns, does not ship them", () => {
  beforeEach(() => jest.resetAllMocks());

  it("strips integrationConnectionId and externalEventId from the returned event", async () => {
    let returningArg: unknown;
    const updatedRow = {
      ...wireRow(),
      integrationConnectionId: 91,
      externalEventId: "ext-abc",
    };
    const tx = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }) },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockImplementation((arg: unknown) => {
              returningArg = arg;
              return Promise.resolve([updatedRow]);
            }),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue([]),
      }),
    };
    const db = {
      transaction: jest
        .fn()
        .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const event = await makeService(db).updateEvent(ORG, ACTOR, EVENT_ID, { title: "Renamed" });

    // The two sync columns ARE read — the provider push depends on them...
    expect(returningArg).toBeDefined();
    const projected = Object.keys(returningArg as Record<string, unknown>);
    expect(projected).toContain("integrationConnectionId");
    expect(projected).toContain("externalEventId");
    expect(tx.insert).toHaveBeenCalled();

    // ...and they do not reach the caller, nor do the other seven withheld columns.
    expect(event).not.toBeNull();
    const shipped = Object.keys(event ?? {});
    expect(shipped.sort()).toEqual([...WIRE_COLUMNS].sort());
    for (const withheld of WITHHELD_COLUMNS) expect(shipped).not.toContain(withheld);
    expect(calendarUpdateEventResponseSchema.safeParse(event).success).toBe(true);
  });
});
