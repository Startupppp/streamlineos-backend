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

function makeSelectBuilder(onWhere?: (w: SQL) => void) {
  const builder = {
    select: () => builder,
    from: () => builder,
    where: (w: SQL) => {
      onWhere?.(w);
      return Promise.resolve([]);
    },
    query: {
      projects: { findMany: async () => [] },
      sprints: { findFirst: async () => null },
      tickets: { findMany: async () => [] },
    },
  };
  return builder;
}

describe("DASHBOARD_BUILD_PERMISSION constant", () => {
  it("is exactly the build:manage catalog key", () => {
    expect(DASHBOARD_BUILD_PERMISSION).toBe("build:manage");
  });

  it("is not the HR employees key", () => {
    expect(DASHBOARD_BUILD_PERMISSION).not.toBe("hr:employees:manage");
  });
});

describe("resolveBuildDashboardScope", () => {
  it("calls scopeFor with build:manage and not with hr:employees:manage", async () => {
    const keysSeen: string[] = [];
    const access = {
      scopeFor: async (_u: CurrentUserContext, key: string) => {
        keysSeen.push(key);
        return "all" as DataScope;
      },
    } as unknown as AccessService;
    await resolveBuildDashboardScope(access, makeUser(USER, ORG));
    expect(keysSeen).toContain("build:manage");
    expect(keysSeen).not.toContain("hr:employees:manage");
  });

  it("returns all when the user has all scope", async () => {
    const result = await resolveBuildDashboardScope(makeAccess("all"), makeUser(USER, ORG));
    expect(result).toBe("all");
  });

  it("returns none when the user has no build:manage permission", async () => {
    const result = await resolveBuildDashboardScope(makeAccess("none"), makeUser(USER, ORG));
    expect(result).toBe("none");
  });
});

describe("DashboardProjectService — projectMembers org predicate", () => {
  it("getRecentProjects includes orgId in projectMembers WHERE clause for a non-all scope", async () => {
    let capturedWhere: SQL | undefined;
    const db = makeSelectBuilder((w) => { capturedWhere = w; });
    const service = new DashboardProjectService(db as never, makeAccess("own"));
    await service.getRecentProjects(ORG, makeUser(USER, ORG));

    expect(capturedWhere).toBeDefined();
    const { params } = dialect.sqlToQuery(capturedWhere as SQL);
    expect(params).toContain(ORG);
    expect(params).toContain(USER);
  });

  it("getRecentProjects orgId predicate excludes members of a different org", async () => {
    let capturedWhere: SQL | undefined;
    const db = makeSelectBuilder((w) => { capturedWhere = w; });
    const service = new DashboardProjectService(db as never, makeAccess("own"));
    await service.getRecentProjects(ORG, makeUser(USER, ORG));

    const { params } = dialect.sqlToQuery(capturedWhere as SQL);
    expect(params).toContain(ORG);
    expect(params).not.toContain(ORG2);
  });

  it("the predicate shape matches eq(orgId) AND eq(userId) — both columns present", () => {
    const predicate = and(eq(projectMembers.orgId, ORG), eq(projectMembers.userId, USER));
    const { sql: sqlStr } = dialect.sqlToQuery(predicate as SQL);
    expect(sqlStr).toContain('"project_members"."org_id"');
    expect(sqlStr).toContain('"project_members"."user_id"');
  });
});

describe("DashboardProjectService — getActiveSprintSummary SQL aggregate", () => {
  it("returns null when no active sprint is found", async () => {
    const db = makeSelectBuilder();
    const service = new DashboardProjectService(db as never, makeAccess("all"));
    const result = await service.getActiveSprintSummary(ORG, makeUser(USER, ORG));
    expect(result).toBeNull();
  });

  it("returns null when project list is empty (no project memberships, non-all scope)", async () => {
    const db = makeSelectBuilder();
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
