import { CalendarEventDetailService } from "./calendar-event-detail.service";
import { calendarEventDetailSchema } from "./dto/calendar-response.schemas";
import { calendarEvents, organizationMembers } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

const ORG = "org-can-manage";
const CREATOR_USER = "user-creator";
const ATTENDEE_USER = "user-attendee";
const CREATOR_MID = 10;
const ATTENDEE_MID = 20;
const EVENT_ID = 900;

interface EventRow {
  id: number;
  title: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timezone: string;
  color: string | null;
  category: string;
  entityType: string | null;
  entityId: string | null;
  location: string | null;
  meetingUrl: string | null;
  description: string | null;
  rrule: string | null;
  createdByMembershipId: number;
}

function eventRow(createdByMembershipId: number): EventRow {
  return {
    id: EVENT_ID,
    title: "Quarterly review",
    startDate: new Date("2026-09-10T09:00:00Z"),
    endDate: new Date("2026-09-10T10:00:00Z"),
    allDay: false,
    timezone: "UTC",
    color: "blue",
    category: "meeting",
    entityType: null,
    entityId: null,
    location: null,
    meetingUrl: null,
    description: "org visible",
    rrule: null,
    createdByMembershipId,
  };
}

function makeDb(membership: { id: number } | undefined, row: EventRow | undefined): Db {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    let table: unknown = null;
    c["from"] = jest.fn((t: unknown) => {
      table = t;
      return c;
    });
    for (const method of ["innerJoin", "leftJoin", "where", "orderBy", "groupBy"])
      c[method] = jest.fn(() => c);
    c["limit"] = jest.fn(() => {
      if (table === calendarEvents) return Promise.resolve(row ? [row] : []);
      if (table === organizationMembers) return Promise.resolve([{ name: "Ada Creator" }]);
      return Promise.resolve([]);
    });
    return c;
  };
  return {
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(membership) },
    },
    select: jest.fn(() => chain()),
  } as unknown as Db;
}

describe("CalendarEventDetailService — canManage mirrors the mutation predicate", () => {
  it("reports canManage true for the creating membership", async () => {
    const svc = new CalendarEventDetailService(makeDb({ id: CREATOR_MID }, eventRow(CREATOR_MID)));

    const detail = await svc.getEvent(ORG, CREATOR_USER, EVENT_ID);

    expect(detail?.canManage).toBe(true);
  });

  it("reports canManage false for a non-creator who can still READ the org-visible event", async () => {
    const svc = new CalendarEventDetailService(makeDb({ id: ATTENDEE_MID }, eventRow(CREATOR_MID)));

    const detail = await svc.getEvent(ORG, ATTENDEE_USER, EVENT_ID);

    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(EVENT_ID);
    expect(detail?.canManage).toBe(false);
  });

  it("never reports canManage true from the zero membership sentinel", async () => {
    const svc = new CalendarEventDetailService(makeDb(undefined, eventRow(0)));

    const detail = await svc.getEvent(ORG, ATTENDEE_USER, EVENT_ID);

    expect(detail).not.toBeNull();
    expect(detail?.canManage).toBe(false);
  });

  it("puts canManage on the wire — the response contract declares it", async () => {
    const svc = new CalendarEventDetailService(makeDb({ id: CREATOR_MID }, eventRow(CREATOR_MID)));

    const detail = await svc.getEvent(ORG, CREATOR_USER, EVENT_ID);
    const parsed = calendarEventDetailSchema.safeParse(detail);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.canManage).toBe(true);
  });

  it("the contract rejects a detail payload with canManage missing (anti-vacuity)", () => {
    const svc = new CalendarEventDetailService(makeDb({ id: CREATOR_MID }, eventRow(CREATOR_MID)));
    expect(svc).toBeDefined();

    const parsed = calendarEventDetailSchema.safeParse({
      id: EVENT_ID,
      title: "Quarterly review",
      startDate: new Date("2026-09-10T09:00:00Z"),
      endDate: new Date("2026-09-10T10:00:00Z"),
      allDay: false,
      timezone: "UTC",
      color: "blue",
      category: "meeting",
      entityType: null,
      entityId: null,
      location: null,
      meetingUrl: null,
      description: null,
      creatorName: null,
      myRsvpStatus: null,
      linkedTicket: null,
      rrule: null,
      isRecurring: false,
    });

    expect(parsed.success).toBe(false);
  });
});
