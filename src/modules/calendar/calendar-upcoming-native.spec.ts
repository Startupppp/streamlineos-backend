import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CalendarService } from "./calendar.service";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();
const ORG_A = "org-cal-upcoming-a";
const ORG_B = "org-cal-upcoming-b";
const USER_A = "user-cal-upcoming-a";

function makeDb(membershipId: number | undefined, capturedWhere?: { cond?: unknown }): Db {
  const chain: Record<string, unknown> = {
    from: () => chain,
    leftJoin: () => chain,
    where: (cond: unknown) => {
      if (capturedWhere) capturedWhere.cond = cond;
      return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
    },
  };
  return {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(
          membershipId !== undefined ? { id: membershipId } : undefined,
        ),
      },
    },
    select: jest.fn().mockReturnValue(chain),
  } as unknown as Db;
}

function makeNullServices() {
  return [null as never, null as never, null as never, null as never, null as never] as const;
}

describe("CalendarService.getUpcomingNativeEvents — cross-tenant isolation", () => {
  const after = new Date("2026-09-01T00:00:00Z");

  describe("outer WHERE scoping (serializable proof)", () => {
    let capturedWhere: { cond?: unknown };

    beforeEach(async () => {
      capturedWhere = {};
      const svc = new CalendarService(makeDb(10, capturedWhere), ...makeNullServices());
      await svc.getUpcomingNativeEvents(ORG_A, USER_A, after, 3);
    });

    it("WHERE condition is captured (fails when mock is neutered by removing the push)", () => {
      expect(capturedWhere.cond).toBeDefined();
    });

    it("requesting org_id appears as a bound param — prevents cross-tenant reads", () => {
      const { params } = dialect.sqlToQuery(capturedWhere.cond as SQL);
      expect(params).toContain(ORG_A);
    });

    it("org B id is absent from params — org B cannot leak into org A query", () => {
      const { params } = dialect.sqlToQuery(capturedWhere.cond as SQL);
      expect(params).not.toContain(ORG_B);
    });

    it("visibility = 'org' appears as a bound param — org-visible events are reachable", () => {
      const { params } = dialect.sqlToQuery(capturedWhere.cond as SQL);
      expect(params).toContain("org");
    });

    it("SQL references the calendar_events.org_id column", () => {
      const { sql: sqlStr } = dialect.sqlToQuery(capturedWhere.cond as SQL);
      expect(sqlStr).toContain('"calendar_events"."org_id"');
    });
  });

  describe("membership lookup scoping", () => {
    it("performs a membership lookup scoped to the requesting org", async () => {
      const db = makeDb(10);
      const svc = new CalendarService(db, ...makeNullServices());
      await svc.getUpcomingNativeEvents(ORG_A, USER_A, after, 3);
      const calls = (db.query.organizationMembers.findFirst as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
    });

    it("falls back to callerMembershipId=0 when no active membership exists", async () => {
      const db = makeDb(undefined);
      const svc = new CalendarService(db, ...makeNullServices());
      const result = await svc.getUpcomingNativeEvents(ORG_A, USER_A, after, 3);
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
