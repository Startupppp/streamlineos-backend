jest.mock("../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { makeMembershipStateStub } from "../../../test/helpers/membership-state-stub";
import {
  AccessService,
} from "./access.service";
import { AccessVersionCache } from "./access-version-cache";
import { namespaceOf } from "../../common/rbac/module-vocabulary";
import type { DataScope } from "./access.types";
import type { Db } from "../../db/drizzle.module";
/* A value import, not `import type`: the assertion below reads the real prototype. */
import { CacheService } from "../../common/cache/cache.service";
import type { EntitlementsService } from "./entitlements.service";
import { bumpPermissionsVersion, type DbOrTx } from "../../common/rbac/access-invalidate";
import {
  ALL_PERMISSION_NAMES,
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSIONS,
} from "../rbac/permissions";
import { logger } from "../../common/logger/logger.service";
import { makeMfaPolicyStub } from "../../../test/helpers/mfa-policy-stub";

const ACTIVE_MEMBER_BASELINE_PERMISSIONS = new Set([
  ...UNIVERSAL_MEMBER_PERMISSIONS,
  ...(ROLE_DEFAULT_PERMISSIONS["MEMBER"] ?? []),
]);

function expectActiveMemberBaseline(
  resolvedPermissions: Map<string, DataScope>,
): void {
  for (const permissionKey of ACTIVE_MEMBER_BASELINE_PERMISSIONS) {
    expect(resolvedPermissions.has(permissionKey)).toBe(true);
  }
  expect(new Set(resolvedPermissions.keys()).size).toBe(
    resolvedPermissions.size,
  );
}

function makeSelectChain(result: unknown[]): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    where: jest.fn(),
    innerJoin: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

function withTenantTxMock<T extends object>(db: T): T {
  const mutable = db as T & {
    execute?: jest.Mock;
    transaction?: jest.Mock;
  };
  if (typeof mutable.transaction !== "function") {
    mutable.execute = jest.fn().mockResolvedValue(undefined);
    mutable.transaction = jest
      .fn()
      .mockImplementation(async (fn: (tx: T) => Promise<unknown>) => fn(db));
  }
  return db;
}

function buildService(db: unknown): AccessService {
  const cache = {
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockResolvedValue(undefined),
    cachedForOrg(o: string, k: string, fn: () => Promise<unknown>, ttl?: number) {
      return this.cached(`${o}:${k}`, fn, ttl);
    },
    cachedForOrgWith<T>(o: string, k: string, fn: () => Promise<T>) {
      return this.cached(`${o}:${k}`, fn);
    },
    invalidateForOrg(o: string, k: string) {
      return this.invalidate(`${o}:${k}`);
    },
  };
  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    isCoreModule: jest.fn((moduleKey: string) => moduleKey === "kb" || moduleKey === "chat"),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
  };
  const wrappedDb = withTenantTxMock(db as object) as unknown as Db;
  return new AccessService(
    wrappedDb,
    cache as unknown as CacheService,
    entitlements as unknown as EntitlementsService,
    makeMfaPolicyStub(),
    new AccessVersionCache(wrappedDb),
    makeMembershipStateStub(),
  );
}

describe("AccessService.resolveUserPermissions", () => {
  it("resolves the universal and self-service baseline for an active member with no role assignments", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 1 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-1");

    expect(Array.from(result.keys())).toEqual(
      expect.arrayContaining([...UNIVERSAL_MEMBER_PERMISSIONS]),
    );
    expectActiveMemberBaseline(result);
  });

  it("resolves role grants for an active member with a role_assignments row", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 2 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 10 }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: 10, slug: "HR_ADMIN" }]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 10, permissionKey: "hr:employees:view", scope: "all" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-2");

    expect(result.get("hr:employees:view")).toBe("all");
    expect(result.size).toBeGreaterThan(0);
  });

  it("resolves role grants inherited via a principal group membership", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 5 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-uuid-1" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 20 }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 20, slug: "HR_VIEWER" }]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 20, permissionKey: "hr:employees:view", scope: "own" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-5");

    expect(result.get("hr:employees:view")).toBe("own");
  });

  it("group membership with no group role contributes only baseline permissions", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 6 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-uuid-2" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-6");

    expectActiveMemberBaseline(result);
  });

  it("merges group-inherited role grants with direct role grants (broadest scope wins)", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 7 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 30 }]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-uuid-3" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 31 }]))
        .mockReturnValueOnce(makeSelectChain([
          { id: 30, slug: "ROLE_A" },
          { id: 31, slug: "ROLE_B" },
        ]))
        .mockReturnValueOnce(makeSelectChain([
          { roleId: 30, permissionKey: "hr:employees:view", scope: "own" },
          { roleId: 31, permissionKey: "hr:employees:view", scope: "all" },
        ]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-7");

    expect(result.get("hr:employees:view")).toBe("all");
  });

  it("keeps baseline permissions when all role assignments are revoked", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 3 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-3");

    expectActiveMemberBaseline(result);
  });

  it("keeps baseline permissions when all assignments are expired", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 4 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-4");

    expectActiveMemberBaseline(result);
  });
});

describe("AccessService.resolveUserPermissions — module ownership grants", () => {
  it("a module owner gets 'all'-scoped grants for every permission in that module and none for other modules", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 1 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ moduleKey: "hr" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-owner", "user-owner");

    expect(result.size).toBeGreaterThan(0);
    expect(result.get("hr:employees:view")).toBe("all");
    expect(result.get("kb:pages:view")).toBe("all");
    expect(result.get("self:onboarding-docs")).toBe("own");
  });

  it("a user-denied module yields no permissions for its module owner (strip step still runs post-ownership-grant)", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 1 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ moduleKey: "hr" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ moduleKey: "hr" }])),
    };

    const result = await buildService(db).resolveUserPermissions("org-owner", "user-owner");

    for (const permissionKey of ACTIVE_MEMBER_BASELINE_PERMISSIONS) {
      if (namespaceOf(permissionKey) === "hr") {
        expect(result.has(permissionKey)).toBe(false);
      } else {
        expect(result.has(permissionKey)).toBe(true);
      }
    }
  });
});

describe("AccessService.resolveUserPermissions — Build assignment and denial", () => {
  function buildMemberDb(denied: boolean) {
    return {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, role: "MEMBER", status: "ACTIVE", id: 7 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-build" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ permissionKey: "build:tickets:view", scope: "all" }]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 55 }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 55, slug: "BUILD_MEMBER" }]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 55, permissionKey: "build:access:view", scope: "all" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain(denied ? [{ moduleKey: "build" }] : [])),
    };
  }

  it("keeps a group-assigned member's Build view and a direct Build grant when not denied", async () => {
    const result = await buildService(buildMemberDb(false)).resolveUserPermissions("org-build", "user-build");

    expect(result.get("build:access:view")).toBe("all");
    expect(result.get("build:tickets:view")).toBe("all");
  });

  it("removes group-derived and direct Build grants for a denied Org Member", async () => {
    const result = await buildService(buildMemberDb(true)).resolveUserPermissions("org-build", "user-build");

    expect(result.has("build:access:view")).toBe(false);
    expect(result.has("build:tickets:view")).toBe(false);
    expect(result.get("self:onboarding-docs")).toBe("own");
  });
});

describe("AccessService.resolveUserPermissions — version bump invalidates local version cache", () => {
  it("a permission version bump is observed by the next resolve call in the same process", async () => {
    let currentVersion = 1;
    const selectChain = makeSelectChain([]);
    const db = {
      query: {
        accessVersions: {
          findFirst: jest.fn().mockImplementation(() =>
            Promise.resolve({ permissionsVersion: currentVersion }),
          ),
        },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 1 }),
        },
      },
      select: jest.fn().mockReturnValue(selectChain),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation(
      async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
    );

    const cache = {
      cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
      invalidate: jest.fn().mockResolvedValue(undefined),
      cachedForOrg(o: string, k: string, fn: () => Promise<unknown>, ttl?: number) {
      return this.cached(`${o}:${k}`, fn, ttl);
    },
      cachedForOrgWith<T>(o: string, k: string, fn: () => Promise<T>) {
      return this.cached(`${o}:${k}`, fn);
    },
      invalidateForOrg(o: string, k: string) {
      return this.invalidate(`${o}:${k}`);
    },
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    };
    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleMap: jest.fn().mockResolvedValue({}),
      getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    };
    const versionCacheSvc = new AccessVersionCache(db as unknown as Db);
    const svc = new AccessService(
      db as unknown as Db,
      cache as unknown as CacheService,
      entitlements as unknown as EntitlementsService,
      makeMfaPolicyStub(),
      versionCacheSvc,
      makeMembershipStateStub(),
    );
    svc.onModuleInit();

    await svc.resolveUserPermissions("org-bump", "user-bump");
    expect(db.query.accessVersions.findFirst).toHaveBeenCalledTimes(1);
    svc["membershipAccessCache"].set("org-bump:user-bump", {
      active: true,
      isOwnerOrAdmin: false,
      expiresAt: Date.now() + 30_000,
    });

    currentVersion = 2;
    await bumpPermissionsVersion(db as unknown as DbOrTx, "org-bump");

    expect(svc["membershipAccessCache"].has("org-bump:user-bump")).toBe(false);
    expect(cache.invalidateNamespace).not.toHaveBeenCalled();
    /*
     * The rule is that a version bump invalidates by exact key and never by
     * wildcard scan (backend §6). This used to be written as
     * `expect(cache.invalidatePattern).not.toHaveBeenCalled()` against a double
     * that stubbed `invalidatePattern` — a method `CacheService` does not have
     * and no production code calls. It could not fail, in either direction.
     *
     * Asserting the method is absent from the real class is the same rule stated
     * so that it CAN fail: re-adding a wildcard invalidator breaks this line,
     * which is the moment somebody should be made to argue for it.
     */
    expect(Object.getOwnPropertyNames(CacheService.prototype)).not.toContain(
      "invalidatePattern",
    );
    expect(cache.invalidate).toHaveBeenCalledWith("org-bump:rbac:members");
    expect(cache.invalidate).toHaveBeenCalledWith(
      "org-bump:module-access:candidates",
    );
    await svc.resolveUserPermissions("org-bump", "user-bump");
    expect(db.query.accessVersions.findFirst).toHaveBeenCalledTimes(2);

    (versionCacheSvc as unknown as Record<string, Map<string, { version: number; expiresAt: number }>>)["versionCache"].delete("org-bump");
    cache.invalidateNamespace.mockClear();
    cache.invalidate.mockClear();
    currentVersion = 3;
    await bumpPermissionsVersion(db as unknown as DbOrTx, "org-bump");
    expect(cache.invalidateNamespace).not.toHaveBeenCalled();
    /*
     * The second bump still has to invalidate by exact key — that is what the
     * inert `not.toHaveBeenCalled()` here was standing in for, and asserting the
     * positive is what actually holds the behaviour down.
     */
    expect(cache.invalidate).toHaveBeenCalledWith("org-bump:rbac:members");

    svc.onModuleDestroy();
  });
});

describe("AccessService.resolveUserPermissions — unknown permission keys are omitted from the resolved map", () => {
  const STALE_KEY = "deleted:legacy:key";
  const KNOWN_KEY = ALL_PERMISSION_NAMES[0] ?? "hr:employees:view";

  it("a stale role-grant key absent from the catalog is silently dropped and does not appear in the resolved map", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 10 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 50 }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: 50, slug: "STALE_ROLE" }]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 50, permissionKey: STALE_KEY, scope: "all" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-stale", "user-stale");

    expect(result.has(STALE_KEY)).toBe(false);
    expectActiveMemberBaseline(result);
  });

  it("a known role-grant key still resolves normally when accompanied by a stale key", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 11 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 51 }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: 51, slug: "MIXED_ROLE" }]))
        .mockReturnValueOnce(makeSelectChain([
          { roleId: 51, permissionKey: KNOWN_KEY, scope: "all" },
          { roleId: 51, permissionKey: STALE_KEY, scope: "all" },
        ]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-mixed", "user-mixed");

    expect(result.has(STALE_KEY)).toBe(false);
    expect(result.get(KNOWN_KEY)).toBe("all");
    expectActiveMemberBaseline(result);
  });

  it("a stale key in a delegation row is dropped and does not appear in the resolved map", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 12 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(
          makeSelectChain([
            {
              permissionKey: STALE_KEY,
              startsAt: new Date(Date.now() - 60_000),
              endsAt: new Date(Date.now() + 60_000),
            },
          ]),
        )
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-del", "user-del");

    expect(result.has(STALE_KEY)).toBe(false);
    expectActiveMemberBaseline(result);
  });

  it("the same stale key triggers the warning log only once across multiple resolve calls (per-instance dedup)", async () => {
    const makeDb = () => ({
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 13 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 52 }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: 52, slug: "STALE_R2" }]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 52, permissionKey: STALE_KEY, scope: "all" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    });

    const cache = {
      cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
      invalidate: jest.fn().mockResolvedValue(undefined),
      cachedForOrg(o: string, k: string, fn: () => Promise<unknown>, ttl?: number) {
      return this.cached(`${o}:${k}`, fn, ttl);
    },
      cachedForOrgWith<T>(o: string, k: string, fn: () => Promise<T>) {
      return this.cached(`${o}:${k}`, fn);
    },
      invalidateForOrg(o: string, k: string) {
      return this.invalidate(`${o}:${k}`);
    },
    };
    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleMap: jest.fn().mockResolvedValue({}),
      getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    };
    const logWarnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined);

    const db1 = withTenantTxMock(makeDb());
    const versionCacheSvc2 = new AccessVersionCache(db1 as unknown as Db);
    const svc = new AccessService(
      db1 as unknown as Db,
      cache as unknown as CacheService,
      entitlements as unknown as EntitlementsService,
      makeMfaPolicyStub(),
      versionCacheSvc2,
      makeMembershipStateStub(),
    );

    await svc.resolveUserPermissions("org-dedup", "user-dedup");

    const db2 = withTenantTxMock(makeDb());
    (svc as unknown as { db: unknown }).db = db2;
    cache.cached.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());
    (versionCacheSvc2 as unknown as Record<string, Map<string, { version: number; expiresAt: number }>>)["versionCache"].clear();
    svc["permsCache"].clear();

    await svc.resolveUserPermissions("org-dedup", "user-dedup2");

    const unknownKeyWarnings = logWarnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("unknown permission key") &&
        (call[1] as Record<string, unknown>)?.["key"] === STALE_KEY,
    );
    expect(unknownKeyWarnings.length).toBe(1);

    logWarnSpy.mockRestore();
  });
});
