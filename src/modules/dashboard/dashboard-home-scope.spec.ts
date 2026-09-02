import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import { leaveApprovalScope } from "../hr/time/leaves-scope";
import {
  buildScopedDashboardCacheKey,
  buildOrgDashboardCacheKey,
} from "./dashboard-cache-key";
import { resolveDashboardStatsFlags } from "./dashboard-scope";
import { attendance, leaveRequests } from "../../db/schema";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { CacheService } from "../../common/cache/cache.service";

async function cacheKeyForOrg(orgId: string, localKey: string): Promise<string> {
  const cache = new CacheService(null);
  return cache.orgScopedKey(orgId, localKey);
}

const dialect = new PgDialect();
const ORG = "org_test_1";
const ORG2 = "org_test_2";
const ACTOR = "user_actor_1";
const ACTOR2 = "user_actor_2";

const toSql = (condition: SQL) => dialect.sqlToQuery(condition).sql;

function makeAccess(version: number): AccessService {
  return {
    getPermissionsVersion: async (_orgId: string) => version,
    resolveUserPermissions: async (_orgId: string, _userId: string) =>
      new Map<string, DataScope>(),
  } as unknown as AccessService;
}

function makeUser(userId: string, orgId: string): CurrentUserContext {
  return { userId, orgId } as CurrentUserContext;
}

describe("attendance scope predicate isolation", () => {
  it("all scope returns unrestricted predicate", () => {
    expect(
      toSql(applyScope("all", ORG, ACTOR, { ownerColumn: attendance.userId })),
    ).toBe("true");
  });

  it("own scope restricts to actor userId column", () => {
    const result = toSql(
      applyScope("own", ORG, ACTOR, { ownerColumn: attendance.userId }),
    );
    expect(result).toContain('"attendance"."user_id"');
    expect(result).not.toBe("true");
  });

  it("team scope narrows to the actor while team membership is not materialised", () => {
    const result = toSql(
      applyScope("team", ORG, ACTOR, { ownerColumn: attendance.userId }),
    );
    const own = toSql(applyScope("own", ORG, ACTOR, { ownerColumn: attendance.userId }));
    expect(result).not.toBe("true");
    expect(result).toContain('"attendance"."user_id"');
    expect(result).toBe(own);
  });

  it("none scope returns false predicate", () => {
    expect(
      toSql(applyScope("none", ORG, ACTOR, { ownerColumn: attendance.userId })),
    ).toBe("false");
  });

  it("each scope produces a distinct SQL predicate", () => {
    const sqls = (["all", "own", "team", "none"] as const).map((scope) =>
      toSql(applyScope(scope, ORG, ACTOR, { ownerColumn: attendance.userId })),
    );
    expect(new Set(sqls).size).toBe(3);
  });
});

describe("leave approval scope predicate isolation", () => {
  it("all scope returns unrestricted predicate", () => {
    expect(toSql(leaveApprovalScope("all", 1))).toBe("true");
  });

  it("none scope returns false predicate", () => {
    expect(toSql(leaveApprovalScope("none", 1))).toBe("false");
  });

  it("own scope does not return unrestricted predicate", () => {
    expect(toSql(leaveApprovalScope("own", 1))).not.toBe("true");
  });

  it("team scope does not return unrestricted predicate", () => {
    expect(toSql(leaveApprovalScope("team", 1))).not.toBe("true");
  });

  it("separates unrestricted, denied and approver-bound predicates", () => {
    const sqls = (["all", "own", "none"] as const).map((scope) =>
      toSql(leaveApprovalScope(scope, 1)),
    );
    expect(new Set(sqls).size).toBe(3);
  });

  it("binds own and team alike, because the derived approver is the boundary for both", () => {
    expect(toSql(leaveApprovalScope("team", 1))).toBe(
      toSql(leaveApprovalScope("own", 1)),
    );
  });
});

describe("scoped dashboard cache key isolation", () => {
  it("(b) different scopes for same actor in same org produce different keys", async () => {
    const access = makeAccess(1);
    const u = makeUser(ACTOR, ORG);
    const [k1, k2] = await Promise.all([
      buildScopedDashboardCacheKey(access, u, "attendance", "all", "2024-01-01"),
      buildScopedDashboardCacheKey(access, u, "attendance", "own", "2024-01-01"),
    ]);
    expect(k1).not.toBe(k2);
  });

  it("(b) different actors in same org with same scope produce different keys", async () => {
    const access = makeAccess(1);
    const u1 = makeUser(ACTOR, ORG);
    const u2 = makeUser(ACTOR2, ORG);
    const [k1, k2] = await Promise.all([
      buildScopedDashboardCacheKey(access, u1, "attendance", "own"),
      buildScopedDashboardCacheKey(access, u2, "attendance", "own"),
    ]);
    expect(k1).not.toBe(k2);
  });

  it("(c) the org segment comes from cachedForOrg, not from the local key", async () => {
    const access = makeAccess(1);
    const local = await buildScopedDashboardCacheKey(
      access,
      makeUser(ACTOR, ORG),
      "attendance",
      "all",
    );
    expect(local).not.toContain(ORG);

    const cache = new CacheService(null);
    const seen: string[] = [];
    for (const orgId of [ORG, ORG2]) {
      await cache.cachedForOrg(orgId, local, async () => {
        return null;
      });
      seen.push(orgId);
    }
    const k1 = await cacheKeyForOrg(ORG, local);
    const k2 = await cacheKeyForOrg(ORG2, local);
    expect(k1).not.toBe(k2);
    expect(k1).toContain(ORG);
    expect(seen).toHaveLength(2);
  });

  it("(c) different actors across different orgs produce different keys", async () => {
    const u1 = makeUser(ACTOR, ORG);
    const u2 = makeUser(ACTOR2, ORG2);
    const [k1, k2] = await Promise.all([
      buildScopedDashboardCacheKey(makeAccess(1), u1, "attendance", "all"),
      buildScopedDashboardCacheKey(makeAccess(1), u2, "attendance", "all"),
    ]);
    expect(k1).not.toBe(k2);
  });

  it("(d) permission version bump changes the scoped cache key", async () => {
    const u = makeUser(ACTOR, ORG);
    const [k1, k2] = await Promise.all([
      buildScopedDashboardCacheKey(makeAccess(1), u, "attendance", "all"),
      buildScopedDashboardCacheKey(makeAccess(2), u, "attendance", "all"),
    ]);
    expect(k1).not.toBe(k2);
  });

  it("(d) permission version bump changes the org-wide cache key", async () => {
    const [k1, k2] = await Promise.all([
      buildOrgDashboardCacheKey(makeAccess(1), ORG, "stats"),
      buildOrgDashboardCacheKey(makeAccess(2), ORG, "stats"),
    ]);
    expect(k1).not.toBe(k2);
  });

  it("dimension is included in the key when provided", async () => {
    const u = makeUser(ACTOR, ORG);
    const access = makeAccess(1);
    const [withDim, withoutDim] = await Promise.all([
      buildScopedDashboardCacheKey(access, u, "attendance", "all", "2024-01-01"),
      buildScopedDashboardCacheKey(access, u, "attendance", "all"),
    ]);
    expect(withDim).not.toBe(withoutDim);
    expect(withDim).toContain("2024-01-01");
  });
});

describe("getLeavesToday scope application", () => {
  const ownerColumn = { ownerColumn: leaveRequests.userId };

  it("(e) is a roster read, so it filters by whose leave it is, not by who approves it", () => {
    const roster = toSql(applyScope("own", ORG, ACTOR, ownerColumn));
    const approval = toSql(leaveApprovalScope("own", 1));
    expect(roster).toContain('"leave_requests"."user_id"');
    expect(roster).not.toContain('"leave_requests"."approver_id"');
    expect(approval).toContain('"leave_requests"."approver_membership_id"');
    expect(roster).not.toBe(approval);
  });

  it("(e) all scope applies an unrestricted predicate", () => {
    expect(toSql(applyScope("all", ORG, ACTOR, ownerColumn))).toBe("true");
  });

  it("(e) team scope never widens to the whole organization", () => {
    const result = toSql(applyScope("team", ORG, ACTOR, ownerColumn));
    expect(result).not.toBe("true");
    expect(result).toContain('"leave_requests"."user_id"');
  });

  it("(e) a viewer holding no approval scope collapses to own, never to the whole org", async () => {
    const { DashboardLeaveService } = await import("./dashboard-leave.service");

    const capturedWheres: SQL[] = [];
    const builder = {
      select: () => builder,
      from: () => builder,
      innerJoin: () => builder,
      leftJoin: () => builder,
      where: (condition: SQL) => {
        capturedWheres.push(condition);
        return builder;
      },
      orderBy: () => builder,
      limit: () => Promise.resolve([]),
      then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
    };
    const accessMock = {
      getPermissionsVersion: async () => 1,
      resolveUserPermissions: async () => new Map<string, DataScope>(),
    } as unknown as AccessService;

    const service = new DashboardLeaveService(
      builder as never,
      { cached: async (_k: string, f: () => Promise<unknown>) => f() } as never,
      accessMock,
    );
    await service.getLeavesToday(makeUser(ACTOR, ORG));

    expect(capturedWheres.length).toBeGreaterThan(0);
    for (const captured of capturedWheres) {
      const query = dialect.sqlToQuery(captured);
      expect(query.sql).toContain('"leave_requests"."user_id" = ');
      expect(query.params).toContain(ACTOR);
      expect(query.sql).not.toContain("scope_teammate");
    }
  });

  it("(e) bounds the leaves-today read and reports the untruncated total", async () => {
    const { DashboardLeaveService } = await import("./dashboard-leave.service");
    const { DASHBOARD_LIST_CAP } = await import("./dashboard-read-limits");

    const rows = Array.from({ length: DASHBOARD_LIST_CAP }, (_v, i) => ({ id: i }));
    let limitArg: number | undefined;
    let call = 0;
    const builder = {
      select: () => builder,
      from: () => builder,
      innerJoin: () => builder,
      leftJoin: () => builder,
      where: () => {
        call += 1;
        return call === 2
          ? Promise.resolve([{ count: DASHBOARD_LIST_CAP + 37 }])
          : builder;
      },
      orderBy: () => builder,
      limit: (n: number) => {
        limitArg = n;
        return Promise.resolve(rows);
      },
    };
    const accessMock = {
      getPermissionsVersion: async () => 1,
      resolveUserPermissions: async () =>
        new Map<string, DataScope>([["hr:leaves:approve", "all"]]),
    } as unknown as AccessService;

    const service = new DashboardLeaveService(
      builder as never,
      { cached: async (_k: string, f: () => Promise<unknown>) => f() } as never,
      accessMock,
    );
    const result = await service.getLeavesToday(makeUser(ACTOR, ORG));

    expect(limitArg).toBe(DASHBOARD_LIST_CAP);
    expect(result.data).toHaveLength(DASHBOARD_LIST_CAP);
    expect(result.total).toBe(DASHBOARD_LIST_CAP + 37);
    expect(result.hasMore).toBe(true);
  });
});

describe("dashboard stats flags", () => {
  function accessWithAttendanceScope(scope: DataScope): AccessService {
    return {
      getPermissionsVersion: async () => 1,
      scopeFor: async (_u: CurrentUserContext, key: string) =>
        key === "hr:attendance:manage" ? scope : "all",
      resolveUserPermissions: async () =>
        new Map<string, DataScope>([["hr:attendance:manage", scope]]),
    } as unknown as AccessService;
  }

  it("shows the org-wide present count only to an all-scope attendance reader", async () => {
    const all = await resolveDashboardStatsFlags(
      accessWithAttendanceScope("all"),
      makeUser(ACTOR, ORG),
    );
    expect(all.attendance).toBe(true);
  });

  it("withholds the org-wide present count from own and team scopes", async () => {
    for (const scope of ["own", "team", "none"] as const) {
      const flags = await resolveDashboardStatsFlags(
        accessWithAttendanceScope(scope),
        makeUser(ACTOR, ORG),
      );
      expect(flags.attendance).toBe(false);
    }
  });
});
