process.env.APP_URL ??= "http://localhost:1000";

import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import type { DataScope } from "../../../access/access.types";
import { LEAVES_PERMISSION } from "../leaves-scope";
import { LeavesService } from "../leaves.service";
import { LeavesWriteService } from "../leaves-write.service";

const ORG_ID = "org-1";

function makeUser(userId: string): CurrentUserContext {
  return {
    userId,
    orgId: ORG_ID,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: `session-${userId}`,
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

class FakeRedis {
  readonly store = new Map<string, unknown>();

  get<T>(key: string): Promise<T | null> {
    return Promise.resolve((this.store.get(key) as T | undefined) ?? null);
  }

  set(key: string, value: unknown, options?: { nx?: boolean }): Promise<string | null> {
    if (options?.nx && this.store.has(key)) return Promise.resolve(null);
    this.store.set(key, value);
    return Promise.resolve("OK");
  }

  incr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return Promise.resolve(next);
  }

  eval(_script: string, keys: string[], _args: string[]): Promise<number> {
    for (const key of keys) this.store.delete(key);
    return Promise.resolve(1);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }
}

/**
 * Drizzle's select builder is chained synchronously and awaited at the end, so a
 * thenable that ignores every intermediate call is enough to stand in for it.
 */
function selectChain(rows: () => unknown[]) {
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows()).then(resolve),
  };
  for (const method of ["from", "innerJoin", "where", "groupBy", "orderBy"])
    chain[method] = () => chain;
  return chain;
}

describe("leave analytics filtered read-after-write", () => {
  let redis: FakeRedis;
  let cache: CacheService;
  let approvedCount: number;
  let analyticsQueries: number;

  function buildReader(scope: DataScope) {
    const db = {
      select: () => {
        analyticsQueries += 1;
        return selectChain(() => [
          {
            department: "Engineering",
            total: approvedCount,
            approved: approvedCount,
            pending: 0,
            rejected: 0,
            month: "Jan",
            monthNum: 1,
            count: approvedCount,
            typeName: "Annual Leave",
            avgDays: 2,
          },
        ]);
      },
    };
    const access = {
      resolveUserPermissions: jest
        .fn()
        .mockResolvedValue(new Map<string, DataScope>([[LEAVES_PERMISSION, scope]])),
    };
    return new LeavesService(db as never, cache, access as never, undefined as never, undefined as never);
  }

  function buildWriter() {
    const tx = {
      query: {
        leaveRequests: {
          findFirst: jest.fn().mockResolvedValue({
            id: 7,
            orgId: ORG_ID,
            userId: "employee-1",
            leaveTypeId: 1,
            startDate: "2026-01-05",
            endDate: "2026-01-06",
            status: "PENDING",
            rowVersion: 1,
          }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 7 }]),
          }),
        }),
      }),
    };
    const db = {
      query: {
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
        leaveTypes: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    return new LeavesWriteService(
      db as never,
      { logCritical: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
      cache,
      { membersWithPermission: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  beforeEach(() => {
    redis = new FakeRedis();
    cache = new CacheService(redis as never);
    approvedCount = 1;
    analyticsQueries = 0;
  });

  it("serves a filtered view from cache, then refreshes it after a write", async () => {
    const reader = buildReader("all");
    const user = makeUser("hr-1");

    const first = await reader.analytics(user, 2026);
    expect(first.byLeaveType).toEqual([{ typeName: "Annual Leave", count: 1 }]);
    expect(analyticsQueries).toBe(4);

    approvedCount = 9;
    const cached = await reader.analytics(user, 2026);
    expect(cached.byLeaveType).toEqual([{ typeName: "Annual Leave", count: 1 }]);
    expect(analyticsQueries).toBe(4);

    await buildWriter().cancel(makeUser("employee-1"), 7);

    const refreshed = await reader.analytics(user, 2026);
    expect(refreshed.byLeaveType).toEqual([{ typeName: "Annual Leave", count: 9 }]);
    expect(analyticsQueries).toBe(8);
  });

  it("refreshes a second year's view the same write invalidated, not only the one just read", async () => {
    const reader = buildReader("all");
    const user = makeUser("hr-1");

    await reader.analytics(user, 2025);
    await reader.analytics(user, 2026);
    expect(analyticsQueries).toBe(8);

    approvedCount = 4;
    await buildWriter().cancel(makeUser("employee-1"), 7);

    const year2025 = await reader.analytics(user, 2025);
    const year2026 = await reader.analytics(user, 2026);
    expect(year2025.byLeaveType).toEqual([{ typeName: "Annual Leave", count: 4 }]);
    expect(year2026.byLeaveType).toEqual([{ typeName: "Annual Leave", count: 4 }]);
  });

  it("keys the cached view by scope and year beneath the tenant namespace", async () => {
    const user = makeUser("hr-1");
    await buildReader("all").analytics(user, 2026);
    await buildReader("team").analytics(user, 2026);
    await buildReader("all").analytics(user, 2025);

    const namespace = CACHE_KEYS.leaveAnalyticsNamespace(ORG_ID);
    const viewKeys = [...redis.store.keys()].filter((key) => key.startsWith(`${namespace}:v`));

    expect(viewKeys.sort()).toEqual([
      `${namespace}:v0:all:2025`,
      `${namespace}:v0:all:2026`,
      `${namespace}:v0:team:2026`,
    ]);
    expect(viewKeys.every((key) => key.includes(ORG_ID))).toBe(true);
  });

  it("does not serve one tenant's cached view to another", async () => {
    const reader = buildReader("all");
    await reader.analytics(makeUser("hr-1"), 2026);

    approvedCount = 5;
    const otherOrgUser = { ...makeUser("hr-2"), orgId: "org-2" };
    const otherOrgView = await reader.analytics(otherOrgUser, 2026);

    expect(otherOrgView.byLeaveType).toEqual([{ typeName: "Annual Leave", count: 5 }]);
  });
});
