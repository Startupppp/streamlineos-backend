import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import * as schema from "../../../db/schema";
import { projects, tickets } from "../../../db/schema";
import { allCountByStatusQuery, memberProjectIdsQuery, ProjectsWorkQueryService } from "./projects-work-query.service";
import { mineCountByStatusSql } from "./work-scope-union";
import type { Db } from "../../../db/drizzle.module";

const ORG_ID = "org-scope-test";
const USER_ID = "user-scope-test";

function makeDb() {
  return drizzle(
    postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }),
    { schema },
  );
}

const dialect = new PgDialect();

function renderSql(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]);
  return { sql: query.sql, params: query.params };
}

function sampleWhere() {
  return (
    and(
      eq(tickets.orgId, ORG_ID),
      ne(projects.status, "ARCHIVED"),
      isNull(tickets.deletedAt),
      inArray(tickets.projectId, [10, 20]),
    ) ?? sql`true`
  );
}

function makeUser(orgId: string) {
  return {
    orgId,
    userId: USER_ID,
    role: "MEMBER" as const,
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: false },
  };
}

function makeMembershipSelectChain(rows: { projectId: number }[]) {
  const memberWhere = jest.fn().mockResolvedValue(rows);
  const memberInnerJoin = jest.fn().mockReturnValue({ where: memberWhere });
  const memberFrom = jest.fn().mockReturnValue({ innerJoin: memberInnerJoin });
  return { memberFrom, memberWhere };
}

describe("countTicketsByStatus — project-membership scope", () => {
  describe("memberProjectIdsQuery — active-membership filter shared by both scope paths", () => {
    const compiled = memberProjectIdsQuery(makeDb(), ORG_ID, USER_ID).toSQL();

    it("filters the organization_members join by status = ACTIVE, so deactivated members are excluded from the scope", () => {
      expect(compiled.params).toContain("ACTIVE");
      expect(compiled.sql).toMatch(/"organization_members"\."status"\s*=\s*\$\d+/);
    });

    it("binds the caller org_id as a parameter rather than inlining it as a literal", () => {
      expect(compiled.params).toContain(ORG_ID);
      expect(compiled.sql).not.toContain(ORG_ID);
    });

    it("binds the caller user_id as a parameter rather than inlining it as a literal", () => {
      expect(compiled.params).toContain(USER_ID);
      expect(compiled.sql).not.toContain(USER_ID);
    });

    it("inner-joins both project_members and organization_members so the intersection requires an active org membership", () => {
      const lower = compiled.sql.toLowerCase();
      expect(lower).toContain("project_members");
      expect(lower).toContain("organization_members");
      expect(lower).toContain("inner join");
    });
  });

  describe("scope:all — allCountByStatusQuery with base conditions", () => {
    const where = sampleWhere();
    const compiled = allCountByStatusQuery(makeDb(), where).toSQL();
    const lower = compiled.sql.toLowerCase();

    it("excludes soft-deleted tickets via deleted_at is null in the WHERE clause", () => {
      expect(lower).toMatch(/deleted_at.*is null/);
    });

    it("excludes archived projects by binding the ARCHIVED status literal as a parameter", () => {
      expect(compiled.params).toContain("ARCHIVED");
      expect(compiled.sql).not.toContain("ARCHIVED");
    });

    it("binds org_id as a parameter rather than inlining it as a literal", () => {
      expect(compiled.params).toContain(ORG_ID);
      expect(compiled.sql).not.toContain(ORG_ID);
    });

    it("inner-joins tickets to projects so the archived-status predicate on projects applies to every counted row", () => {
      expect(lower).toContain("inner join");
      expect(lower).toContain("project");
    });

    it("groups by status so the caller receives a per-status breakdown and not a single total", () => {
      expect(lower).toContain("group by");
      expect(lower).toContain("status");
    });

    it("restricts to the caller's project membership by including project_id in the WHERE", () => {
      expect(lower).toContain("project_id");
      expect(compiled.params).toContain(10);
      expect(compiled.params).toContain(20);
    });
  });

  describe("scope:mine — mineCountByStatusSql with project-membership filter in the where clause", () => {
    const mineWhere = (
      and(
        ne(projects.status, "ARCHIVED"),
        isNull(tickets.deletedAt),
        inArray(tickets.projectId, [10, 20]),
      ) ?? sql`true`
    );
    const rendered = renderSql(mineCountByStatusSql(mineWhere, ORG_ID, USER_ID));
    const lower = rendered.sql.toLowerCase();

    it("binds org_id as a parameter on every UNION branch via the membership subqueries, so neither branch can read outside the tenant", () => {
      const orgBindings = rendered.params.filter((p) => p === ORG_ID).length;
      expect(orgBindings).toBeGreaterThanOrEqual(2);
      expect(rendered.sql).not.toContain(ORG_ID);
    });

    it("binds user_id as a parameter on both UNION branches, restricting each branch to the caller's own assignments", () => {
      const userBindings = rendered.params.filter((p) => p === USER_ID).length;
      expect(userBindings).toBeGreaterThanOrEqual(2);
      expect(rendered.sql).not.toContain(USER_ID);
    });

    it("carries the project_id in-list from the where clause so only projects the caller is a member of are counted", () => {
      expect(lower).toContain("project_id");
      expect(rendered.params).toContain(10);
      expect(rendered.params).toContain(20);
    });

    it("carries the deleted_at is null predicate from the where clause so soft-deleted tickets are excluded", () => {
      expect(rendered.sql).toMatch(/deleted_at.*is null/i);
    });

    it("carries the archived-projects exclusion from the where clause via the ARCHIVED parameter", () => {
      expect(rendered.params).toContain("ARCHIVED");
    });

    it("uses UNION across the primary-assignee and ticket_assignees branches so multi-assignee tickets are not double-counted", () => {
      expect(rendered.sql.toUpperCase()).toContain("UNION");
      expect(lower).toContain("ticket_assignees");
    });
  });

  describe("countTicketsByStatus — wiring: membership result reaches the count query", () => {
    describe("scope:mine", () => {
      it("returns empty without issuing a ticket query when the caller belongs to zero projects", async () => {
        const { memberFrom } = makeMembershipSelectChain([]);
        const dbExecute = jest.fn();
        const db = {
          select: jest.fn().mockReturnValue({ from: memberFrom }),
          execute: dbExecute,
        } as unknown as Db;

        const svc = new ProjectsWorkQueryService(db);
        const result = await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "mine" });

        expect(result).toEqual({ byStatus: {}, total: 0 });
        expect(dbExecute).not.toHaveBeenCalled();
      });

      it("the count query SQL carries the caller's member project-ids so non-member tickets cannot contribute", async () => {
        const { memberFrom } = makeMembershipSelectChain([{ projectId: 7 }, { projectId: 9 }]);
        const capturedSqlArgs: unknown[] = [];
        const dbExecute = jest.fn().mockImplementation((arg: unknown) => {
          capturedSqlArgs.push(arg);
          return Promise.resolve([]);
        });
        const db = {
          select: jest.fn().mockReturnValue({ from: memberFrom }),
          execute: dbExecute,
        } as unknown as Db;

        const svc = new ProjectsWorkQueryService(db);
        await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "mine" });

        expect(dbExecute).toHaveBeenCalledTimes(1);
        const rendered = renderSql(capturedSqlArgs[0]);
        expect(rendered.params).toContain(7);
        expect(rendered.params).toContain(9);
      });

      it("excludes project-ids the caller is not a member of even when projectIds filter includes them", async () => {
        const { memberFrom } = makeMembershipSelectChain([{ projectId: 7 }]);
        const capturedSqlArgs: unknown[] = [];
        const dbExecute = jest.fn().mockImplementation((arg: unknown) => {
          capturedSqlArgs.push(arg);
          return Promise.resolve([]);
        });
        const db = {
          select: jest.fn().mockReturnValue({ from: memberFrom }),
          execute: dbExecute,
        } as unknown as Db;

        const svc = new ProjectsWorkQueryService(db);
        await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "mine", projectIds: [7, 99] });

        expect(dbExecute).toHaveBeenCalledTimes(1);
        const rendered = renderSql(capturedSqlArgs[0]);
        expect(rendered.params).toContain(7);
        expect(rendered.params).not.toContain(99);
      });

      it("returns empty without a ticket query when projectIds filter produces an empty intersection with membership", async () => {
        const { memberFrom } = makeMembershipSelectChain([{ projectId: 7 }]);
        const dbExecute = jest.fn();
        const db = {
          select: jest.fn().mockReturnValue({ from: memberFrom }),
          execute: dbExecute,
        } as unknown as Db;

        const svc = new ProjectsWorkQueryService(db);
        const result = await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "mine", projectIds: [99] });

        expect(result).toEqual({ byStatus: {}, total: 0 });
        expect(dbExecute).not.toHaveBeenCalled();
      });
    });

    describe("scope:all", () => {
      it("returns empty without issuing a count query when the caller belongs to zero projects", async () => {
        const { memberFrom } = makeMembershipSelectChain([]);
        const dbSelect = jest.fn().mockReturnValue({ from: memberFrom });
        const db = { select: dbSelect } as unknown as Db;

        const svc = new ProjectsWorkQueryService(db);
        const result = await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "all" });

        expect(result).toEqual({ byStatus: {}, total: 0 });
        expect(dbSelect).toHaveBeenCalledTimes(1);
      });

      it("the count query WHERE carries the caller's member project-ids so non-member tickets cannot contribute", async () => {
        const { memberFrom } = makeMembershipSelectChain([{ projectId: 7 }]);

        const capturedWhereArgs: unknown[] = [];
        const countGroupBy = jest.fn().mockResolvedValue([]);
        const countWhere = jest.fn().mockImplementation((w: unknown) => {
          capturedWhereArgs.push(w);
          return { groupBy: countGroupBy };
        });
        const countInnerJoin = jest.fn().mockReturnValue({ where: countWhere });
        const countFrom = jest.fn().mockReturnValue({ innerJoin: countInnerJoin });

        const dbSelect = jest.fn()
          .mockReturnValueOnce({ from: memberFrom })
          .mockReturnValueOnce({ from: countFrom });
        const db = { select: dbSelect } as unknown as Db;

        const svc = new ProjectsWorkQueryService(db);
        await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "all" });

        expect(countWhere).toHaveBeenCalledTimes(1);
        const rendered = renderSql(capturedWhereArgs[0]);
        expect(rendered.params).toContain(7);
      });

      it("excludes project-ids the caller is not a member of even when projectIds filter includes them", async () => {
        const { memberFrom } = makeMembershipSelectChain([{ projectId: 7 }]);

        const capturedWhereArgs: unknown[] = [];
        const countGroupBy = jest.fn().mockResolvedValue([]);
        const countWhere = jest.fn().mockImplementation((w: unknown) => {
          capturedWhereArgs.push(w);
          return { groupBy: countGroupBy };
        });
        const countInnerJoin = jest.fn().mockReturnValue({ where: countWhere });
        const countFrom = jest.fn().mockReturnValue({ innerJoin: countInnerJoin });

        const dbSelect = jest.fn()
          .mockReturnValueOnce({ from: memberFrom })
          .mockReturnValueOnce({ from: countFrom });
        const db = { select: dbSelect } as unknown as Db;

        const svc = new ProjectsWorkQueryService(db);
        await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "all", projectIds: [7, 99] });

        const rendered = renderSql(capturedWhereArgs[0]);
        expect(rendered.params).toContain(7);
        expect(rendered.params).not.toContain(99);
      });

      it("returns empty without a count query when projectIds filter produces an empty intersection with membership", async () => {
        const { memberFrom } = makeMembershipSelectChain([{ projectId: 7 }]);
        const dbSelect = jest.fn().mockReturnValue({ from: memberFrom });
        const db = { select: dbSelect } as unknown as Db;

        const svc = new ProjectsWorkQueryService(db);
        const result = await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "all", projectIds: [99] });

        expect(result).toEqual({ byStatus: {}, total: 0 });
        expect(dbSelect).toHaveBeenCalledTimes(1);
      });
    });
  });
});
