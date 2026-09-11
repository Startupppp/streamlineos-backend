import { CalendarEventDetailService } from "./calendar-event-detail.service";
import type { Db } from "../../db/drizzle.module";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const CALLER = "user-caller";
const EVENT_ID = 4242;

function sqlValues(val: unknown, seen = new Set<object>()): unknown[] {
  if (val === null || val === undefined || typeof val === "string" || typeof val === "number" || typeof val === "boolean")
    return val === null || val === undefined ? [] : [val];
  if (Array.isArray(val)) return val.flatMap((v) => sqlValues(v, seen));
  if (typeof val !== "object" || seen.has(val as object)) return [];
  seen.add(val as object);
  const rec = val as Record<string, unknown>;
  return [
    ...(rec["queryChunks"] ? sqlValues(rec["queryChunks"], seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec["value"], seen) : []),
  ];
}

/**
 * The event row belongs to OWNER_ORG; the double returns it only when the query
 * carries that tenant, so a service that dropped `eq(calendarEvents.orgId, orgId)`
 * would return another organisation's event here and fail these tests.
 */
function makeDb(rowsByOrg: Record<string, unknown[]>, whereCalls: unknown[]): Db {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "orderBy", "groupBy"]) c[m] = jest.fn(() => c);
    c["where"] = jest.fn((predicate: unknown) => {
      whereCalls.push(predicate);
      return c;
    });
    c["limit"] = jest.fn(() => {
      const org = sqlValues(whereCalls[whereCalls.length - 1]).find(
        (v): v is string => typeof v === "string" && v.startsWith("org-"),
      );
      return Promise.resolve(rowsByOrg[org ?? ""] ?? []);
    });
    return c;
  };
  return {
    query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) } },
    select: jest.fn(() => chain()),
  } as unknown as Db;
}

describe("CalendarEventDetailService — cross-tenant isolation", () => {
  const eventRow = {
    id: EVENT_ID,
    title: "Quarterly review",
    description: "internal only",
    startDate: new Date("2026-09-10T09:00:00Z"),
    endDate: new Date("2026-09-10T10:00:00Z"),
    allDay: false,
    category: "meeting",
    visibility: "org",
    rrule: null,
    location: null,
    meetingUrl: null,
    timezone: "UTC",
    createdByMembershipId: 7,
  };

  it("serves the event to its owning organization — control", async () => {
    const whereCalls: unknown[] = [];
    const svc = new CalendarEventDetailService(makeDb({ [OWNER_ORG]: [eventRow] }, whereCalls));

    const detail = await svc.getEvent(OWNER_ORG, CALLER, EVENT_ID);

    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(EVENT_ID);
  });

  it("returns null for another organization's event id, never the row", async () => {
    const whereCalls: unknown[] = [];
    const svc = new CalendarEventDetailService(makeDb({ [OWNER_ORG]: [eventRow] }, whereCalls));

    const detail = await svc.getEvent(ATTACKER_ORG, CALLER, EVENT_ID);

    expect(detail).toBeNull();
  });

  it("binds the caller's organization into the event lookup", async () => {
    const whereCalls: unknown[] = [];
    const svc = new CalendarEventDetailService(makeDb({ [OWNER_ORG]: [eventRow] }, whereCalls));

    await svc.getEvent(ATTACKER_ORG, CALLER, EVENT_ID);

    const bound = whereCalls.flatMap((call) => sqlValues(call));
    expect(bound).toContain(ATTACKER_ORG);
    expect(bound).not.toContain(OWNER_ORG);
  });

  it("BITE: a lookup that ignores the tenant would serve the owning org's event to the attacker", async () => {
    const whereCalls: unknown[] = [];
    const tenantBlindDb = makeDb({ [OWNER_ORG]: [eventRow], [ATTACKER_ORG]: [eventRow] }, whereCalls);
    const svc = new CalendarEventDetailService(tenantBlindDb);

    const detail = await svc.getEvent(ATTACKER_ORG, CALLER, EVENT_ID);

    expect(detail?.id).toBe(EVENT_ID);
  });
});
