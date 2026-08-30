/**
 * Verifies that DashboardPersonalService.getPersonalDashboard applies the
 * calendar-event visibility predicate to the upcoming-events query.
 *
 * Required gate: visibility = "org" OR creator = caller OR
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
 * subquery) and a recursive column-name walker (for the outer condition, which
 * contains an exists() wrapping a mock sub-chain that cannot be serialized).
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
 * specific column reference without needing to fully serialize it (the outer
 * condition's exists() arm wraps a mock chain, not a real sub-SELECT).
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
 * .select().from().where() call. The inner subquery for EXISTS is captured
 * because it is evaluated before the outer .where() is called.
 *
 * capturedConditions[0] = inner EXISTS subquery WHERE
 * capturedConditions[1] = outer upcomingEvents WHERE
 * capturedConditions[2] = notifications WHERE
 * (timesheets / leaveBalance calls are suppressed via moduleAvailability=false)
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
  describe("inner EXISTS subquery (attendee arm)", () => {
    let innerCond: SQL;

    beforeEach(async () => {
      const captured: unknown[] = [];
      const svc = new DashboardPersonalService(makeDb(captured), makeAccess());
      await svc.getPersonalDashboard(makeUser(ORG));
      // First captured condition is the inner EXISTS subquery WHERE
      innerCond = captured[0] as SQL;
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
      // Second captured condition is the outer upcomingEvents WHERE
      outerCond = captured[1];
    });

    it("SCENARIO 1 — private-event arm: outer WHERE contains a visibility column reference", () => {
      expect(hasColumnNamed(outerCond, "visibility")).toBe(true);
    });

    it("SCENARIO 1 — organizer arm: outer WHERE references created_by for creator check", () => {
      expect(hasColumnNamed(outerCond, "created_by")).toBe(true);
    });

    it("SCENARIO 4 — cross-org: outer WHERE references the org_id column on calendar_events", () => {
      expect(hasColumnNamed(outerCond, "org_id")).toBe(true);
    });
  });

  describe("schema — columns required by the visibility predicate are present", () => {
    it("calendarEvents schema columns include both 'visibility' and 'createdBy'", () => {
      const keys = Object.keys(calendarEvents);
      expect(keys).toContain("visibility");
      expect(keys).toContain("createdBy");
    });

    it("eventAttendees schema includes status column (needed for declined-attendee exclusion)", () => {
      expect(Object.keys(eventAttendees)).toContain("status");
    });

    it("organizationMembers schema includes status column (needed for departed-member exclusion)", () => {
      expect(Object.keys(organizationMembers)).toContain("status");
    });
  });
});
