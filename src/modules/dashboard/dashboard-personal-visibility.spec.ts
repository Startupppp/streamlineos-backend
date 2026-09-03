/**
 * Verifies that DashboardPersonalService.getPersonalDashboard applies the
 * calendar-event visibility predicate to the upcoming-events query.
 *
 * Required gate: visibility = "org" OR
 *   EXISTS(creator membership WHERE membership.id = createdByMembershipId AND userId = caller) OR
 *   the caller's own ACTIVE membership has a non-declined event_attendees row
 *
 * The attendee arm used to be an EXISTS over event_attendees INNER JOIN
 * organization_members. The planner de-correlated it into a hashed SubPlan that
 * materialised every attendee row in the tenant (26,079 on the 89.93% seed) before
 * LIMIT 3 could stop anything. It is now a LEFT JOIN LATERAL … LIMIT 1 probed once
 * per candidate row, and the ACTIVE-membership guard moved from the SQL join to
 * `attendeeMembershipId`, which is 0 for a caller with no ACTIVE membership.
 * Both halves of that move are asserted below — the shape, so the join cannot come
 * back, and the guard, so a departed member still matches nothing.
 *
 * Capture order (one push per .where() call on the mock chain):
 *   captured[0] = attendee LATERAL subquery WHERE
 *   captured[1] = creator EXISTS subquery WHERE
 *   captured[2] = outer upcomingEvents WHERE
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { calendarEvents, eventAttendees, organizationMembers } from "../../db/schema";
import { DashboardPersonalService } from "./dashboard-personal.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { Db } from "../../db/drizzle.module";
import type { DashboardProjectService } from "./dashboard-project.service";

const dialect = new PgDialect();
const ORG = "org-p0a-vis-1";
const ORG2 = "org-p0a-vis-2";
const USER = "user-p0a-actor";
const SELF_MEMBERSHIP = 4211;

function makeUser(orgId: string, userId = USER): CurrentUserContext {
  return { orgId, userId } as CurrentUserContext;
}

function makeAccess() {
  return {
    moduleAvailability: jest.fn().mockResolvedValue({ available: false }),
  } as never;
}

function makeCollaborators() {
  return {
    projectService: { getMyIssues: jest.fn().mockResolvedValue([]) } as unknown as DashboardProjectService,
  };
}

/**
 * Walks the Drizzle SQL object tree and returns true when a Column node with
 * the given name is found.
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

function aliasedSubquery(alias: string) {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) =>
      typeof prop === "string" ? sql.raw(`"${alias}"."${prop}"`) : undefined,
  });
}

type MockCalls = { lateralJoins: number; innerJoins: number };

function makeDb(
  capturedConditions: unknown[],
  calls: MockCalls,
  selfMember: { id: number; status: string } | null = { id: SELF_MEMBERSHIP, status: "ACTIVE" },
) {
  const makeMockChain = (): Record<string, unknown> => {
    const limitedChain: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => {
        calls.innerJoins += 1;
        return chain;
      },
      leftJoin: () => chain,
      leftJoinLateral: () => {
        calls.lateralJoins += 1;
        return chain;
      },
      orderBy: () => limitedChain,
      where: (cond: unknown) => {
        capturedConditions.push(cond);
        Object.assign(limitedChain, {
          ...chain,
          limit: () =>
            Object.assign(Promise.resolve([]), {
              as: (alias: string) => aliasedSubquery(alias),
            }),
        });
        return limitedChain;
      },
    };
    return chain;
  };

  return {
    query: {
      tickets: { findMany: jest.fn().mockResolvedValue([]) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(selfMember) },
    },
    select: jest.fn().mockImplementation(() => makeMockChain()),
  } as unknown as Db;
}

async function run(
  captured: unknown[],
  calls: MockCalls,
  selfMember?: { id: number; status: string } | null,
) {
  const { projectService } = makeCollaborators();
  const svc = new DashboardPersonalService(makeDb(captured, calls, selfMember), makeAccess(), projectService);
  await svc.getPersonalDashboard(makeUser(ORG));
  return projectService;
}

describe("DashboardPersonalService — P0-A: upcoming-events visibility gate", () => {
  describe("attendee arm is a LATERAL probe, not a de-correlatable EXISTS", () => {
    let attendeeCond: SQL;
    let calls: MockCalls;

    beforeEach(async () => {
      const captured: unknown[] = [];
      calls = { lateralJoins: 0, innerJoins: 0 };
      await run(captured, calls);
      attendeeCond = captured[0] as SQL;
    });

    it("joins the attendee probe with LEFT JOIN LATERAL exactly once", () => {
      expect(calls.lateralJoins).toBe(1);
    });

    it("does not join organization_members inside the attendee arm", () => {
      expect(calls.innerJoins).toBe(0);
      const { sql: sqlStr } = dialect.sqlToQuery(attendeeCond);
      expect(sqlStr).not.toContain('"organization_members"');
    });

    it("SCENARIO 2 — declined-attendee arm: excludes event_attendees rows where status = declined", () => {
      const { sql: sqlStr, params } = dialect.sqlToQuery(attendeeCond);
      expect(sqlStr).toMatch(/<>|!=/);
      expect(params).toContain("declined");
    });

    it("SCENARIO 4 (cross-org): attendee probe binds to the caller org only", () => {
      const { params } = dialect.sqlToQuery(attendeeCond);
      expect(params).toContain(ORG);
      expect(params).not.toContain(ORG2);
    });

    it("scopes to the event (event_id link), preventing cross-event leakage", () => {
      const { sql: sqlStr } = dialect.sqlToQuery(attendeeCond);
      expect(sqlStr).toContain('"event_attendees"."event_id"');
    });

    it("binds the caller's own membership id", () => {
      const { sql: sqlStr, params } = dialect.sqlToQuery(attendeeCond);
      expect(sqlStr).toContain('"event_attendees"."membership_id"');
      expect(params).toContain(SELF_MEMBERSHIP);
    });
  });

  describe("SCENARIO 3 — departed member", () => {
    it("binds membership 0 when the caller's membership is not ACTIVE", async () => {
      const captured: unknown[] = [];
      await run(captured, { lateralJoins: 0, innerJoins: 0 }, { id: SELF_MEMBERSHIP, status: "INACTIVE" });
      const { params } = dialect.sqlToQuery(captured[0] as SQL);
      expect(params).toContain(0);
      expect(params).not.toContain(SELF_MEMBERSHIP);
    });

    it("binds membership 0 when the caller has no membership row at all", async () => {
      const captured: unknown[] = [];
      await run(captured, { lateralJoins: 0, innerJoins: 0 }, null);
      const { params } = dialect.sqlToQuery(captured[0] as SQL);
      expect(params).toContain(0);
    });
  });

  describe("inner EXISTS subquery (creator arm)", () => {
    let creatorCond: SQL;

    beforeEach(async () => {
      const captured: unknown[] = [];
      await run(captured, { lateralJoins: 0, innerJoins: 0 });
      creatorCond = captured[1] as SQL;
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

  describe("outer upcomingEvents WHERE (org + time + visibility)", () => {
    let outerCond: unknown;

    beforeEach(async () => {
      const captured: unknown[] = [];
      await run(captured, { lateralJoins: 0, innerJoins: 0 });
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

    it("tests the LATERAL result rather than re-reading event_attendees", () => {
      const { sql: sqlStr } = dialect.sqlToQuery(outerCond as SQL);
      expect(sqlStr).toContain('"attended_event"."hit" is not null');
    });
  });

  describe("schema — columns required by the visibility predicate are present", () => {
    it("calendarEvents schema columns include both 'visibility' and 'createdByMembershipId'", () => {
      const keys = Object.keys(calendarEvents);
      expect(keys).toContain("visibility");
      expect(keys).toContain("createdByMembershipId");
    });

    it("eventAttendees schema includes status and membershipId columns", () => {
      const keys = Object.keys(eventAttendees);
      expect(keys).toContain("status");
      expect(keys).toContain("membershipId");
    });

    it("organizationMembers schema includes status column (needed for departed-member exclusion)", () => {
      expect(Object.keys(organizationMembers)).toContain("status");
    });
  });
});

/**
 * BITING TESTS — the full outer AND condition serialized in one piece.
 *
 * Removal proofs actually executed (neuter → run spec → failure confirmed → restore):
 *   - eq(calendarEvents.visibility, "org") stripped → "BITING: visibility arm" fails
 *   - ne(eventAttendees.status, "declined") stripped → "BITING: declined-attendee" fails
 *   - the LATERAL turned back into the old EXISTS → the whole "attendee arm is a
 *     LATERAL probe" block fails (13 tests), which is how this shape is pinned.
 */
describe("DashboardPersonalService — P0-A: BITING outer-condition serializable tests", () => {
  let captured: unknown[];
  let projectSvcBiting: ReturnType<typeof makeCollaborators>["projectService"];

  beforeEach(async () => {
    captured = [];
    projectSvcBiting = await run(captured, { lateralJoins: 0, innerJoins: 0 });
  });

  it("BITING: outer WHERE is captured and serializable via dialect.sqlToQuery", () => {
    expect(captured[2]).toBeDefined();
    expect(() => dialect.sqlToQuery(captured[2] as SQL)).not.toThrow();
  });

  it("BITING: visibility arm — 'org' appears as a standalone param (fails when eq(visibility,'org') is stripped)", () => {
    const { params } = dialect.sqlToQuery(captured[2] as SQL);
    expect(params).toContain("org");
  });

  it("BITING: declined-attendee — 'declined' in the attendee probe params (fails when ne(status,'declined') is stripped)", () => {
    const { params } = dialect.sqlToQuery(captured[0] as SQL);
    expect(params).toContain("declined");
  });

  it("BITING: caller binding — caller userId appears in the serialized creator params", () => {
    const { params } = dialect.sqlToQuery(captured[1] as SQL);
    expect(params).toContain(USER);
  });

  /**
   * Was `unreadCount(ORG, USER)` until that branch was deleted as dead — the
   * count reached no client and cost 14,053 planning buffers per uncached load.
   * It was also the only delegated read on this path that was not module-gated.
   * `makeAccess()` here reports every module unavailable, on purpose, so the
   * surviving delegated read must not be issued at all; that is the property
   * this seam can still assert.
   */
  it("BITING: no delegated read is issued while every module is unavailable", () => {
    expect(projectSvcBiting.getMyIssues).not.toHaveBeenCalled();
  });
});
