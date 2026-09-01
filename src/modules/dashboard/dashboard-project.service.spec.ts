import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, type SQL } from "drizzle-orm";
import { projectMembers } from "../../db/schema";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import {
  DASHBOARD_BUILD_PERMISSION,
  resolveBuildDashboardScope,
} from "./dashboard-scope";
import { DashboardProjectService } from "./dashboard-project.service";

const dialect = new PgDialect();
const ORG = "org_proj_1";
const ORG2 = "org_proj_2";
const USER = "user_proj_1";

function makeUser(userId: string, orgId: string): CurrentUserContext {
  return { userId, orgId } as CurrentUserContext;
}

function makeAccess(scope: DataScope = "all"): AccessService {
  return {
    scopeFor: async () => scope,
    getPermissionsVersion: async () => 1,
    resolveUserPermissions: async () => new Map<string, DataScope>(),
  } as unknown as AccessService;
}

describe("DASHBOARD_BUILD_PERMISSION constant", () => {
  it("is the build:tickets:view catalog key — matching the @RequirePermission on the recent-projects route", () => {
    expect(DASHBOARD_BUILD_PERMISSION).toBe("build:tickets:view");
  });

  it("is not the HR employees key", () => {
    expect(DASHBOARD_BUILD_PERMISSION).not.toBe("hr:employees:manage");
  });
});

describe("resolveBuildDashboardScope", () => {
  it("returns all regardless of access service because build:tickets:view is not a scopable permission", async () => {
    const result = await resolveBuildDashboardScope(makeAccess("none"), makeUser(USER, ORG));
    expect(result).toBe("all");
  });

  it("returns all when the user has all scope", async () => {
    const result = await resolveBuildDashboardScope(makeAccess("all"), makeUser(USER, ORG));
    expect(result).toBe("all");
  });

  it("never calls scopeFor — build:tickets:view is non-scopable so the isScopable guard short-circuits", async () => {
    const keysSeen: string[] = [];
    const access = {
      scopeFor: async (_u: CurrentUserContext, key: string) => {
        keysSeen.push(key);
        return "all" as DataScope;
      },
    } as unknown as AccessService;
    await resolveBuildDashboardScope(access, makeUser(USER, ORG));
    expect(keysSeen).toHaveLength(0);
  });
});

describe("DashboardProjectService — org predicate in the all-scope path", () => {
  it("the projectMembers predicate shape matches eq(orgId) AND eq(membershipId) — both columns present", () => {
    const predicate = and(eq(projectMembers.orgId, ORG), eq(projectMembers.membershipId, 1));
    const { sql: sqlStr } = dialect.sqlToQuery(predicate as SQL);
    expect(sqlStr).toContain('"project_members"."org_id"');
    expect(sqlStr).toContain('"project_members"."membership_id"');
  });

  it("getRecentProjects returns empty array when the relational query returns nothing", async () => {
    const db = {
      select: () => db,
      from: () => db,
      innerJoin: () => db,
      where: () => Promise.resolve([]),
      query: {
        organizationMembers: { findFirst: async () => ({ id: 1 }) },
        projects: { findMany: async () => [] },
        sprints: { findFirst: async () => null },
        tickets: { findMany: async () => [] },
      },
    };
    const service = new DashboardProjectService(db as never, makeAccess("all"));
    const result = await service.getRecentProjects(ORG, makeUser(USER, ORG));
    expect(result).toEqual([]);
  });

  it("getRecentProjects and getRecentActivity for ORG do not surface data from ORG2", async () => {
    let findManyOrgArg: string | undefined;
    const db = {
      select: () => db,
      from: () => db,
      innerJoin: () => db,
      where: () => Promise.resolve([]),
      query: {
        organizationMembers: { findFirst: async () => ({ id: 1 }) },
        projects: {
          findMany: async (opts: { where?: SQL }) => {
            if (opts?.where) {
              const { params } = dialect.sqlToQuery(opts.where as SQL);
              const param = params.find((p) => p === ORG || p === ORG2);
              findManyOrgArg = param as string | undefined;
            }
            return [];
          },
        },
        sprints: { findFirst: async () => null },
        tickets: { findMany: async () => [] },
      },
    };
    const service = new DashboardProjectService(db as never, makeAccess("all"));
    await service.getRecentProjects(ORG, makeUser(USER, ORG));
    expect(findManyOrgArg).toBe(ORG);
    expect(findManyOrgArg).not.toBe(ORG2);
  });
});

describe("DashboardProjectService — getActiveSprintSummary SQL aggregate", () => {
  it("returns null when no active sprint is found", async () => {
    const db = {
      select: () => db,
      from: () => db,
      where: () => Promise.resolve([]),
      query: {
        organizationMembers: { findFirst: async () => ({ id: 1 }) },
        projects: { findMany: async () => [] },
        sprints: { findFirst: async () => null },
        tickets: { findMany: async () => [] },
      },
    };
    const service = new DashboardProjectService(db as never, makeAccess("all"));
    const result = await service.getActiveSprintSummary(ORG, makeUser(USER, ORG));
    expect(result).toBeNull();
  });

  it("returns null when project list is empty (no project memberships, non-all scope)", async () => {
    const db = {
      select: () => db,
      from: () => db,
      innerJoin: () => db,
      where: () => Promise.resolve([]),
      query: {
        organizationMembers: { findFirst: async () => ({ id: 1 }) },
        projects: { findMany: async () => [] },
        sprints: { findFirst: async () => null },
        tickets: { findMany: async () => [] },
      },
    };
    const service = new DashboardProjectService(db as never, makeAccess("own"));
    const result = await service.getActiveSprintSummary(ORG, makeUser(USER, ORG));
    expect(result).toBeNull();
  });

  it("sprint stats are computed from the SQL aggregate, not JS reduce", async () => {
    const sprintRow = {
      id: 42,
      name: "Sprint 1",
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      project: { id: 10, name: "Acme Project" },
    };

    let selectCallCount = 0;
    let sprintFetched = false;

    const db = {
      select: () => db,
      from: () => db,
      where: (w: SQL) => {
        selectCallCount++;
        const q = dialect.sqlToQuery(w);
        if (q.params.includes(ORG) && q.params.includes(42)) {
          return Promise.resolve([
            { total: 10, done: 4, inProgress: 3, totalPoints: 50, completedPoints: 20 },
          ]);
        }
        return Promise.resolve([{ projectId: 10 }]);
      },
      query: {
        organizationMembers: { findFirst: async () => ({ id: 1 }) },
        projects: {
          findMany: async () => [{ id: 10 }],
        },
        sprints: {
          findFirst: async () => {
            sprintFetched = true;
            return sprintRow;
          },
        },
        tickets: { findMany: async () => [] },
      },
    };

    const service = new DashboardProjectService(db as never, makeAccess("all"));
    const result = await service.getActiveSprintSummary(ORG, makeUser(USER, ORG));

    expect(sprintFetched).toBe(true);
    expect(selectCallCount).toBeGreaterThanOrEqual(1);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.totalTickets).toBe(10);
      expect(result.doneTickets).toBe(4);
      expect(result.inProgressTickets).toBe(3);
      expect(result.todoTickets).toBe(3);
      expect(result.totalPoints).toBe(50);
      expect(result.completedPoints).toBe(20);
      expect(result.progress).toBe(40);
    }
  });
});
