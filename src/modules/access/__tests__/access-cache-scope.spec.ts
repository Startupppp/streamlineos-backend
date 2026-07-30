import { AccessService } from "../access.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EntitlementsService } from "../entitlements.service";

describe("CACHE_KEYS.accessPerms — org-scoping", () => {
  it("includes orgId so that keys for different orgs are distinct", () => {
    const keyA = CACHE_KEYS.accessPerms("org-a", "user-1", 1);
    const keyB = CACHE_KEYS.accessPerms("org-b", "user-1", 1);
    expect(keyA).not.toBe(keyB);
  });

  it("includes userId so that keys for different users within the same org are distinct", () => {
    const key1 = CACHE_KEYS.accessPerms("org-a", "user-1", 1);
    const key2 = CACHE_KEYS.accessPerms("org-a", "user-2", 1);
    expect(key1).not.toBe(key2);
  });

  it("includes the version so stale cached entries are bypassed on version bump", () => {
    const v1 = CACHE_KEYS.accessPerms("org-a", "user-1", 1);
    const v2 = CACHE_KEYS.accessPerms("org-a", "user-1", 2);
    expect(v1).not.toBe(v2);
  });

  it("contains the orgId string literally so tenant isolation is transparent", () => {
    const key = CACHE_KEYS.accessPerms("org-acme", "user-x", 3);
    expect(key).toContain("org-acme");
    expect(key).toContain("user-x");
  });
});

function makeSelectChain(result: unknown[]): {
  from: jest.Mock;
  where: jest.Mock;
  innerJoin: jest.Mock;
} {
  const chain = {
    from: jest.fn(),
    where: jest.fn().mockResolvedValue(result),
    innerJoin: jest.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  return chain;
}

function buildService(
  dbOverrides: Partial<{
    query: unknown;
    select: jest.Mock;
  }>,
  cacheOverrides: Partial<{ cached: jest.Mock }> = {},
): AccessService {
  const defaultDb = {
    query: {
      accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 1 }),
      },
      userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      userModuleAccess: {
        findFirst: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
    select: jest.fn().mockReturnValue(makeSelectChain([])),
    ...dbOverrides,
  };

  const defaultCache = {
    cached: jest.fn().mockImplementation(
      async (_key: string, fn: () => Promise<unknown>) => fn(),
    ),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };

  const cache: CacheService = { ...defaultCache, ...cacheOverrides } as unknown as CacheService;
  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
  } as unknown as EntitlementsService;

  return new AccessService(
    defaultDb as unknown as Db,
    cache,
    entitlements,
  );
}

describe("AccessService.resolveUserPermissions — org-scoped Redis cache key", () => {
  it("calls cache.cached with a key that embeds the orgId", async () => {
    const capturedKeys: string[] = [];
    const cache = {
      cached: jest.fn().mockImplementation(
        async (key: string, fn: () => Promise<unknown>) => {
          capturedKeys.push(key);
          return fn();
        },
      ),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 1 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValue(makeSelectChain([])),
    };

    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleMap: jest.fn().mockResolvedValue({}),
      getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    } as unknown as EntitlementsService;

    const svc = new AccessService(
      db as unknown as Db,
      cache as unknown as CacheService,
      entitlements,
    );

    await svc.resolveUserPermissions("org-alpha", "user-1");

    expect(capturedKeys.some((k) => k.includes("org-alpha"))).toBe(true);
    expect(capturedKeys.some((k) => k.includes("user-1"))).toBe(true);
  });

  it("org A and org B produce distinct cache keys — no cross-tenant bleed", async () => {
    const capturedKeys: string[] = [];

    function buildDbForOrg(memberId: number) {
      return {
        query: {
          accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
          organizationMembers: {
            findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: memberId }),
          },
          userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
        },
        select: jest.fn()
          .mockReturnValueOnce(makeSelectChain([]))
          .mockReturnValueOnce(makeSelectChain([]))
          .mockReturnValueOnce(makeSelectChain([]))
          .mockReturnValue(makeSelectChain([])),
      };
    }

    const cache = {
      cached: jest.fn().mockImplementation(
        async (key: string, fn: () => Promise<unknown>) => {
          capturedKeys.push(key);
          return fn();
        },
      ),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleMap: jest.fn().mockResolvedValue({}),
      getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    } as unknown as EntitlementsService;

    const svcA = new AccessService(
      buildDbForOrg(10) as unknown as Db,
      cache as unknown as CacheService,
      entitlements,
    );
    const svcB = new AccessService(
      buildDbForOrg(20) as unknown as Db,
      cache as unknown as CacheService,
      entitlements,
    );

    await svcA.resolveUserPermissions("org-a", "user-shared");
    await svcB.resolveUserPermissions("org-b", "user-shared");

    const keyForOrgA = capturedKeys.find((k) => k.includes("org-a"));
    const keyForOrgB = capturedKeys.find((k) => k.includes("org-b"));

    expect(keyForOrgA).toBeDefined();
    expect(keyForOrgB).toBeDefined();
    expect(keyForOrgA).not.toBe(keyForOrgB);
  });
});

describe("AccessService.resolveUserPermissions — revoked/expired roles grant nothing", () => {
  it("no active role assignments → returns empty permission map", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 3 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValue(makeSelectChain([])),
    };

    const svc = buildService({ query: db.query, select: db.select });
    const result = await svc.resolveUserPermissions("org-1", "user-no-roles");

    expect(result.size).toBe(0);
  });

  it("DB filters expired assignments (expiresAt in the past) — they do not appear in results", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 4 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValue(makeSelectChain([])),
    };

    const svc = buildService({ query: db.query, select: db.select });
    const result = await svc.resolveUserPermissions("org-1", "user-expired-role");

    expect(result.size).toBe(0);
  });

  it("suspended member returns empty permissions regardless of role assignments", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "SUSPENDED", id: 5 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    };

    const svc = buildService({ query: db.query, select: db.select });
    const result = await svc.resolveUserPermissions("org-1", "user-suspended");

    expect(result.size).toBe(0);
  });
});

describe("AccessService.resolveUserPermissions — group-derived role resolution", () => {
  it("group membership → group_role_assignments → role grants appear in the permission map", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 7 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-uuid-1" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 20 }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 20, slug: "HR_VIEWER" }]))
        .mockReturnValueOnce(makeSelectChain([
          { roleId: 20, permissionKey: "hr:employees:view", scope: "own" },
        ]))
        .mockReturnValue(makeSelectChain([])),
    };

    const svc = buildService({ query: db.query, select: db.select });
    const result = await svc.resolveUserPermissions("org-1", "user-in-group");

    expect(result.get("hr:employees:view")).toBe("own");
  });

  it("group with no group_role_assignments contributes no permissions", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 8 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-empty" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValue(makeSelectChain([])),
    };

    const svc = buildService({ query: db.query, select: db.select });
    const result = await svc.resolveUserPermissions("org-1", "user-in-empty-group");

    expect(result.size).toBe(0);
  });

  it("broadest scope wins when direct role and group role overlap on the same permission", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 9 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 30 }]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-uuid-2" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 31 }]))
        .mockReturnValueOnce(makeSelectChain([
          { id: 30, slug: "ROLE_OWN" },
          { id: 31, slug: "ROLE_ALL" },
        ]))
        .mockReturnValueOnce(makeSelectChain([
          { roleId: 30, permissionKey: "hr:employees:view", scope: "own" },
          { roleId: 31, permissionKey: "hr:employees:view", scope: "all" },
        ]))
        .mockReturnValue(makeSelectChain([])),
    };

    const svc = buildService({ query: db.query, select: db.select });
    const result = await svc.resolveUserPermissions("org-1", "user-multi-role");

    expect(result.get("hr:employees:view")).toBe("all");
  });
});
