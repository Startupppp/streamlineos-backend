/**
 * Verifies that DashboardPersonalService.getPersonalDashboard applies the
 * calendar-event visibility predicate to the upcoming-events query.
 *
 * Required gate: visibility = "org" OR
 *   EXISTS(creator membership WHERE membership.id = createdByMembershipId AND userId = caller) OR
 *   EXISTS(attendee joined through organization_members WHERE status = "ACTIVE"
 *          AND attendee.status != "declined")
 *
 * Four scenarios:
 *   1. Private event — viewer is not attendee, not creator → excluded.
 *   2. Declined attendee → excluded from the EXISTS arm.
 *   3. Departed member (no ACTIVE membership) → excluded from the EXISTS arm.
 *   4. Cross-organization event id → excluded by org_id predicate.
 *
 * The tests capture raw Drizzle SQL condition objects and inspect them using
 * PgDialect.sqlToQuery (for pure Drizzle SQL objects in the inner EXISTS
 * subqueries) and a recursive column-name walker (for the outer condition).
 *
 * Capture order (one push per .where() call on the mock chain):
 *   captured[0] = creator EXISTS subquery WHERE
 *   captured[1] = attendee EXISTS subquery WHERE
 *   captured[2] = outer upcomingEvents WHERE
 *   captured[3] = notifications WHERE
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { calendarEvents, eventAttendees, organizationMembers } from "../../db/schema";
import { DashboardPersonalService } from "./dashboard-personal.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();
const ORG = "org-p0a-vis-1";
const ORG2 = "org-p0a-vis-2";
const USER = "user-p0a-actor";

function makeUser(orgId: string, userId = USER): CurrentUserContext {
  return { orgId, userId } as CurrentUserContext;
}

function makeAccess() {
  return {
    moduleAvailability: jest.fn().mockResolvedValue({ available: false }),
  } as never;
}

/**
 * Walks the Drizzle SQL object tree and returns true when a Column node with
 * the given name is found. Used to verify the outer WHERE condition contains a
 * specific column reference without needing to fully serialize it.
 */
function hasColumnNamed(v: unknown, name: string, seen = new Set<object>()): boolean {
  if (!v || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => hasColumnNamed(x, name, seen));
  if (seen.has(v as object)) return false;
  seen.add(v as object);
  const obj = v as Record<string, unknown>;
  if (typeof obj["name"] === "string" && obj["name"] === name) return true;
  return Object.values(obj).some((val) => hasColumnNamed(val, name, seen));
}

/**
 * Builds a mock DB that captures ALL WHERE conditions across every
 * .select().from().where() call.
 *
 * captured[0] = creator EXISTS subquery WHERE
 * captured[1] = attendee EXISTS subquery WHERE
 * captured[2] = outer upcomingEvents WHERE
 * captured[3] = notifications WHERE
 */
function makeDb(capturedConditions: unknown[]) {
  const makeMockChain = (): Record<string, unknown> => {
    const limitedChain: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      orderBy: () => limitedChain,
      where: (cond: unknown) => {
        capturedConditions.push(cond);
        Object.assign(limitedChain, { ...chain, limit: () => Promise.resolve([]) });
        return limitedChain;
      },
    };
    return chain;
  };

  return {
    query: {
      tickets: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: jest.fn().mockImplementation(() => makeMockChain()),
  } as unknown as Db;
}

describe("DashboardPersonalService — P0-A: upcoming-events visibility gate", () => {
  describe("inner EXISTS subquery (creator arm)", () => {
    let creatorCond: SQL;

    beforeEach(async () => {
      const captured: unknown[] = [];
      const svc = new DashboardPersonalService(makeDb(captured), makeAccess());
      await svc.getPersonalDashboard(makeUser(ORG));
      creatorCond = captured[0] as SQL;
    });

    it("SCENARIO 1 — creator arm: checks created_by_membership_id against the caller membership", () => {
      const { sql: sqlStr } = dialect.sqlToQuery(creatorCond);
      expect(sqlStr).toContain('"calendar_events"."created_by_membership_id"');
    });

    it("creator arm restricts to ACTIVE organization_members", () => {
      const { sql: sqlStr, params } = dialect.sqlToQuery(creatorCond);
      expect(sqlStr).toContain('"organization_members"."status"');
      expect(params).toContain("ACTIVE");
    });

    it("creator arm binds the caller userId to resolve the membership", () => {
      const { params } = dialect.sqlToQuery(creatorCond);
      expect(params).toContain(USER);
    });
  });

  describe("inner EXISTS subquery (attendee arm)", () => {
    let innerCond: SQL;

    beforeEach(async () => {
      const captured: unknown[] = [];
      const svc = new DashboardPersonalService(makeDb(captured), makeAccess());
      await svc.getPersonalDashboard(makeUser(ORG));
      innerCond = captured[1] as SQL;
    });

    it("SCENARIO 2 — declined-attendee arm: excludes event_attendees rows where status = declined", () => {
      const { sql: sqlStr, params } = dialect.sqlToQuery(innerCond);
      expect(sqlStr).toMatch(/<>|!=/);
      expect(params).toContain("declined");
    });

    it("SCENARIO 3 — departed-member arm: restricts to ACTIVE organization_members", () => {
      const { sql: sqlStr, params } = dialect.sqlToQuery(innerCond);
      expect(sqlStr).toContain('"organization_members"."status"');
      expect(params).toContain("ACTIVE");
    });

    it("SCENARIO 4 (cross-org): inner attendee subquery binds to caller org only", () => {
      const { params } = dialect.sqlToQuery(innerCond);
      expect(params).toContain(ORG);
      expect(params).not.toContain(ORG2);
    });

    it("inner condition joins to organization_members to resolve active membership", () => {
      const { sql: sqlStr } = dialect.sqlToQuery(innerCond);
      expect(sqlStr).toContain('"organization_members"');
    });

    it("inner condition scopes to the event (event_id link), preventing cross-event leakage", () => {
      const { sql: sqlStr } = dialect.sqlToQuery(innerCond);
      expect(sqlStr).toContain('"event_attendees"."event_id"');
    });
  });

  describe("outer upcomingEvents WHERE (org + time + visibility)", () => {
    let outerCond: unknown;

    beforeEach(async () => {
      const captured: unknown[] = [];
      const svc = new DashboardPersonalService(makeDb(captured), makeAccess());
      await svc.getPersonalDashboard(makeUser(ORG, USER));
      outerCond = captured[2];
    });

    it("SCENARIO 1 — private-event arm: outer WHERE contains a visibility column reference", () => {
      expect(hasColumnNamed(outerCond, "visibility")).toBe(true);
    });

    it("SCENARIO 1 — organizer arm: outer WHERE contains a created_by_membership_id column reference", () => {
      expect(hasColumnNamed(outerCond, "created_by_membership_id")).toBe(true);
    });

    it("SCENARIO 4 — cross-org: outer WHERE references the org_id column on calendar_events", () => {
      expect(hasColumnNamed(outerCond, "org_id")).toBe(true);
    });
  });

  describe("schema — columns required by the visibility predicate are present", () => {
    it("calendarEvents schema columns include both 'visibility' and 'createdByMembershipId'", () => {
      const keys = Object.keys(calendarEvents);
      expect(keys).toContain("visibility");
      expect(keys).toContain("createdByMembershipId");
    });

    it("eventAttendees schema includes status column (needed for declined-attendee exclusion)", () => {
      expect(Object.keys(eventAttendees)).toContain("status");
    });

    it("organizationMembers schema includes status column (needed for departed-member exclusion)", () => {
      expect(Object.keys(organizationMembers)).toContain("status");
    });
  });
});
