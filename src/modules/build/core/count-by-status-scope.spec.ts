import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import * as schema from "../../../db/schema";
import { projects, tickets } from "../../../db/schema";
import { allCountByStatusQuery, ProjectsWorkQueryService } from "./projects-work-query.service";
import { mineCountByStatusSql } from "./work-scope-union";
import { reachableProjectsSql } from "../reachability/project-reachability";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG_ID = "org-scope-test";
const MEMBERSHIP_ID = 42;
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

function makeUser(orgId: string, membershipId: number = MEMBERSHIP_ID): CurrentUserContext {
  return {
    orgId,
    userId: USER_ID,
    role: "MEMBER" as const,
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session" as const, membershipId, isOrgOwner: false },
  } as unknown as CurrentUserContext;
}

function makeUserNoMembership(orgId: string): CurrentUserContext {
  return {
    orgId,
    userId: USER_ID,
    role: "MEMBER" as const,
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "account-only" as const },
  } as unknown as CurrentUserContext;
}

describe("reachableProjectsSql — predicate structure", () => {
  const compiled = renderSql(reachableProjectsSql(ORG_ID, MEMBERSHIP_ID));

  it("binds the caller org_id as a parameter rather than inlining it as a literal", () => {
    expect(compiled.params).toContain(ORG_ID);
    expect(compiled.sql).not.toContain(ORG_ID);
  });

  it("binds the caller membership_id as a parameter rather than inlining it as a literal", () => {
    expect(compiled.params).toContain(MEMBERSHIP_ID);
    expect(compiled.sql).not.toContain(String(MEMBERSHIP_ID));
  });

  it("covers direct project membership via project_members subquery", () => {
    expect(compiled.sql.toLowerCase()).toContain("project_members");
  });

  it("covers team-based access via project_team_assignments subquery", () => {
    expect(compiled.sql.toLowerCase()).toContain("project_team_assignments");
  });

  it("covers manager access via manager_membership_id column comparison", () => {
    expect(compiled.sql.toLowerCase()).toContain("manager_membership_id");
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

describe("countTicketsByStatus — wiring: reachability predicate reaches the count query", () => {
  describe("scope:mine", () => {
    it("returns empty without any DB call when principal has no membershipId (DENY)", async () => {
      const dbExecute = jest.fn();
      const db = { execute: dbExecute } as unknown as Db;
      const svc = new ProjectsWorkQueryService(db);
      const result = await svc.countTicketsByStatus(makeUserNoMembership(ORG_ID), { scope: "mine" });
      expect(result).toEqual({ byStatus: {}, total: 0 });
      expect(dbExecute).not.toHaveBeenCalled();
    });

    it("issues the count query when membershipId is non-null (CONTROL)", async () => {
      const dbExecute = jest.fn().mockResolvedValue([]);
      const db = { execute: dbExecute } as unknown as Db;
      const svc = new ProjectsWorkQueryService(db);
      await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "mine" });
      expect(dbExecute).toHaveBeenCalledTimes(1);
    });

    it("the count query SQL carries the reachability predicate binding the caller membership_id", async () => {
      const capturedSqlArgs: unknown[] = [];
      const dbExecute = jest.fn().mockImplementation((arg: unknown) => {
        capturedSqlArgs.push(arg);
        return Promise.resolve([]);
      });
      const db = { execute: dbExecute } as unknown as Db;
      const svc = new ProjectsWorkQueryService(db);
      await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "mine" });
      expect(dbExecute).toHaveBeenCalledTimes(1);
      const rendered = renderSql(capturedSqlArgs[0]);
      expect(rendered.params).toContain(MEMBERSHIP_ID);
    });

    it("applies projectIds as an AND filter in the count query SQL", async () => {
      const capturedSqlArgs: unknown[] = [];
      const dbExecute = jest.fn().mockImplementation((arg: unknown) => {
        capturedSqlArgs.push(arg);
        return Promise.resolve([]);
      });
      const db = { execute: dbExecute } as unknown as Db;
      const svc = new ProjectsWorkQueryService(db);
      await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "mine", projectIds: [7, 9] });
      const rendered = renderSql(capturedSqlArgs[0]);
      expect(rendered.params).toContain(7);
      expect(rendered.params).toContain(9);
    });
  });

  describe("scope:all", () => {
    it("returns empty without any DB call when principal has no membershipId (DENY)", async () => {
      const dbExecute = jest.fn();
      const dbSelect = jest.fn();
      const db = { execute: dbExecute, select: dbSelect } as unknown as Db;
      const svc = new ProjectsWorkQueryService(db);
      const result = await svc.countTicketsByStatus(makeUserNoMembership(ORG_ID), { scope: "all" });
      expect(result).toEqual({ byStatus: {}, total: 0 });
      expect(dbExecute).not.toHaveBeenCalled();
      expect(dbSelect).not.toHaveBeenCalled();
    });

    it("issues a select query when membershipId is non-null (CONTROL)", async () => {
      const capturedWhereArgs: unknown[] = [];
      const countGroupBy = jest.fn().mockResolvedValue([]);
      const countWhere = jest.fn().mockImplementation((w: unknown) => {
        capturedWhereArgs.push(w);
        return { groupBy: countGroupBy };
      });
      const countInnerJoin = jest.fn().mockReturnValue({ where: countWhere });
      const countFrom = jest.fn().mockReturnValue({ innerJoin: countInnerJoin });
      const dbSelect = jest.fn().mockReturnValue({ from: countFrom });
      const db = { select: dbSelect } as unknown as Db;
      const svc = new ProjectsWorkQueryService(db);
      await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "all" });
      expect(dbSelect).toHaveBeenCalledTimes(1);
    });

    it("the count query WHERE carries the caller membership_id from the reachability predicate", async () => {
      const capturedWhereArgs: unknown[] = [];
      const countGroupBy = jest.fn().mockResolvedValue([]);
      const countWhere = jest.fn().mockImplementation((w: unknown) => {
        capturedWhereArgs.push(w);
        return { groupBy: countGroupBy };
      });
      const countInnerJoin = jest.fn().mockReturnValue({ where: countWhere });
      const countFrom = jest.fn().mockReturnValue({ innerJoin: countInnerJoin });
      const dbSelect = jest.fn().mockReturnValue({ from: countFrom });
      const db = { select: dbSelect } as unknown as Db;
      const svc = new ProjectsWorkQueryService(db);
      await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "all" });
      expect(capturedWhereArgs).toHaveLength(1);
      const rendered = renderSql(capturedWhereArgs[0]);
      expect(rendered.params).toContain(MEMBERSHIP_ID);
    });

    it("applies projectIds as an AND filter in the count query WHERE", async () => {
      const capturedWhereArgs: unknown[] = [];
      const countGroupBy = jest.fn().mockResolvedValue([]);
      const countWhere = jest.fn().mockImplementation((w: unknown) => {
        capturedWhereArgs.push(w);
        return { groupBy: countGroupBy };
      });
      const countInnerJoin = jest.fn().mockReturnValue({ where: countWhere });
      const countFrom = jest.fn().mockReturnValue({ innerJoin: countInnerJoin });
      const dbSelect = jest.fn().mockReturnValue({ from: countFrom });
      const db = { select: dbSelect } as unknown as Db;
      const svc = new ProjectsWorkQueryService(db);
      await svc.countTicketsByStatus(makeUser(ORG_ID), { scope: "all", projectIds: [7, 9] });
      const rendered = renderSql(capturedWhereArgs[0]);
      expect(rendered.params).toContain(7);
      expect(rendered.params).toContain(9);
    });
  });
});
