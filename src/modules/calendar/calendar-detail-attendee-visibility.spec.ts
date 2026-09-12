import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { CalendarEventDetailService } from "./calendar-event-detail.service";
import { CalendarAttendeesService } from "./calendar-attendees.service";
import { CalendarEventSourceLoader } from "./calendar-event-source.loader";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();

const ORG = "org-detail-vis";
const CREATOR_MID = 10;
const ATTENDEE_MID = 20;
const STRANGER_MID = 30;
const EVENT_ID = 777;

interface CapturedPredicate {
  sql: string;
  params: readonly unknown[];
}

function renderPredicate(predicate: unknown): CapturedPredicate {
  const query = dialect.sqlToQuery(predicate as SQL);
  return { sql: query.sql, params: query.params };
}

function capturingDb(callerMembershipId: number, captured: CapturedPredicate[]): Db {
  const chain = (): Record<string, unknown> => {
    const node: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "orderBy", "groupBy", "limit"])
      node[method] = jest.fn(() => node);
    for (const method of ["leftJoin", "where"])
      node[method] = jest.fn((...args: unknown[]) => {
        for (const arg of args) {
          if (arg === undefined || arg === null) continue;
          if (typeof arg !== "object") continue;
          try {
            captured.push(renderPredicate(arg));
          } catch {
            continue;
          }
        }
        return node;
      });
    node["then"] = (resolve: (rows: unknown[]) => unknown) => resolve([]);
    return node;
  };

  return {
    query: {
      organizationMembers: {
        findFirst: jest
          .fn()
          .mockResolvedValue(callerMembershipId > 0 ? { id: callerMembershipId } : undefined),
      },
    },
    select: jest.fn(chain),
  } as unknown as Db;
}

function attendeeArmBindsCaller(
  captured: readonly CapturedPredicate[],
  callerMembershipId: number,
): boolean {
  return captured.some(
    (entry) =>
      /event_attendees|att_visibility_check/i.test(entry.sql) &&
      entry.params.includes(callerMembershipId),
  );
}

async function capturePredicatesFor(
  service: "detail" | "attendees" | "list",
  callerMembershipId: number,
): Promise<CapturedPredicate[]> {
  const captured: CapturedPredicate[] = [];
  const db = capturingDb(callerMembershipId, captured);
  if (service === "detail")
    await new CalendarEventDetailService(db).getEvent(ORG, "user-x", EVENT_ID);
  else if (service === "attendees")
    await new CalendarAttendeesService(db).listAttendees(ORG, "user-x", EVENT_ID);
  else
    await new CalendarEventSourceLoader(db).load(
      ORG,
      "user-x",
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-30T00:00:00Z"),
    );
  return captured;
}

describe("CA1 — the attendee visibility arm is present in the REAL service predicates", () => {
  it.each([["detail"], ["attendees"], ["list"]] as const)(
    "%s binds the caller membership id against the attendee table",
    async (service) => {
      const captured = await capturePredicatesFor(service, ATTENDEE_MID);
      expect(captured.length).toBeGreaterThan(0);
      expect(attendeeArmBindsCaller(captured, ATTENDEE_MID)).toBe(true);
    },
  );

  it.each([["detail"], ["attendees"], ["list"]] as const)(
    "%s binds the caller's own org, never a foreign one",
    async (service) => {
      const captured = await capturePredicatesFor(service, ATTENDEE_MID);
      const allParams = captured.flatMap((entry) => [...entry.params]);
      expect(allParams).toContain(ORG);
      expect(allParams).not.toContain("org-foreign");
    },
  );

  it("binds whichever membership id the caller actually has, not a constant", async () => {
    const asAttendee = await capturePredicatesFor("detail", ATTENDEE_MID);
    const asStranger = await capturePredicatesFor("detail", STRANGER_MID);
    expect(attendeeArmBindsCaller(asAttendee, ATTENDEE_MID)).toBe(true);
    expect(attendeeArmBindsCaller(asStranger, ATTENDEE_MID)).toBe(false);
    expect(attendeeArmBindsCaller(asStranger, STRANGER_MID)).toBe(true);
  });

  it("uses the absent-membership sentinel when the caller has no ACTIVE membership", async () => {
    const captured = await capturePredicatesFor("detail", 0);
    expect(attendeeArmBindsCaller(captured, CREATOR_MID)).toBe(false);
    expect(attendeeArmBindsCaller(captured, 0)).toBe(true);
  });
});

describe("CalendarEventDetailService.getEvent — attendee can view a private event", () => {
  function makeDb(callerMembershipId: number, returnRow: boolean): Db {
    const eventRow = {
      id: EVENT_ID,
      title: "Private event",
      description: null,
      startDate: new Date("2026-09-15T09:00:00Z"),
      endDate: new Date("2026-09-15T10:00:00Z"),
      allDay: false,
      category: "meeting",
      visibility: "private",
      rrule: null,
      location: null,
      meetingUrl: null,
      timezone: "UTC",
      createdByMembershipId: CREATOR_MID,
      entityType: null,
      entityId: null,
      color: "blue",
    };

    let selectCount = 0;
    return {
      query: {
        organizationMembers: {
          findFirst: jest
            .fn()
            .mockResolvedValue(callerMembershipId > 0 ? { id: callerMembershipId } : undefined),
        },
      },
      select: jest.fn().mockImplementation(() => {
        selectCount++;
        const node: Record<string, unknown> = {};
        for (const method of ["from", "innerJoin", "leftJoin", "orderBy", "groupBy"])
          node[method] = jest.fn(() => node);
        node["where"] = jest.fn((predicate: unknown) => {
          const rendered = renderPredicate(predicate);
          const admitsAttendee = /event_attendees|att_visibility_check/i.test(rendered.sql);
          if (selectCount === 1)
            node["limit"] = jest
              .fn()
              .mockResolvedValue(admitsAttendee && returnRow ? [eventRow] : []);
          else node["limit"] = jest.fn().mockResolvedValue([{ name: "Creator" }]);
          return node;
        });
        return node;
      }),
    } as unknown as Db;
  }

  it("returns the event to an attendee of a private event", async () => {
    const service = new CalendarEventDetailService(makeDb(ATTENDEE_MID, true));
    await expect(service.getEvent(ORG, "user-attendee", EVENT_ID)).resolves.not.toBeNull();
  });

  it("returns null to a stranger for the same private event", async () => {
    const service = new CalendarEventDetailService(makeDb(STRANGER_MID, false));
    await expect(service.getEvent(ORG, "user-stranger", EVENT_ID)).resolves.toBeNull();
  });
});
