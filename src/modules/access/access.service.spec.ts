import {
  AccessService,
  broadest,
  evaluateMembershipGate,
  isActiveDelegation,
  isActiveAssignment,
  isPlanGatedModule,
  moduleOf,
  type DelegationRow,
} from "./access.service";
import type { DataScope } from "./access.types";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
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

describe("broadest", () => {
  it("ranks none < own < team < all", () => {
    expect(broadest("none", "own")).toBe("own");
    expect(broadest("own", "team")).toBe("team");
    expect(broadest("team", "all")).toBe("all");
    expect(broadest("none", "all")).toBe("all");
  });

  it("keeps the broader scope regardless of argument order", () => {
    expect(broadest("all", "own")).toBe("all");
    expect(broadest("own", "all")).toBe("all");
  });

  it("returns the same scope when both are equal", () => {
    const scopes: DataScope[] = ["none", "own", "team", "all"];
    for (const scope of scopes) expect(broadest(scope, scope)).toBe(scope);
  });
});

describe("moduleOf", () => {
  it("extracts the part before the first colon", () => {
    expect(moduleOf("hr:employees:view")).toBe("hr");
    expect(moduleOf("settings:rbac:manage")).toBe("settings");
  });

  it("returns the whole key when there is no colon", () => {
    expect(moduleOf("accounting")).toBe("accounting");
  });
});

describe("isPlanGatedModule", () => {
  it("gates the modules an organization actually buys and toggles", () => {
    expect(isPlanGatedModule("hr")).toBe(true);
    expect(isPlanGatedModule("crm")).toBe(true);
    expect(isPlanGatedModule("payroll")).toBe(true);
  });

  it("does not gate settings or self", () => {
    expect(isPlanGatedModule("settings")).toBe(false);
    expect(isPlanGatedModule("self")).toBe(false);
  });

  it("does not gate platform infrastructure, which no org can enable", () => {
    for (const module of [
      "directory",
      "party",
      "ownership",
      "onboarding",
      "workforce",
      "notifications",
      "dashboard",
      "billing",
      "branch",
      "audit-log",
    ]) {
      expect(isPlanGatedModule(module)).toBe(false);
    }
  });
});

describe("evaluateMembershipGate", () => {
  it("denies when there is no membership row", () => {
    expect(evaluateMembershipGate(null)).toEqual({ active: false, isOwner: false });
    expect(evaluateMembershipGate(undefined)).toEqual({ active: false, isOwner: false });
  });

  it("denies a suspended member even if the owner flag is set", () => {
    expect(evaluateMembershipGate({ status: "SUSPENDED", isOwner: true })).toEqual({
      active: false,
      isOwner: false,
    });
  });

  it("denies a member who has left", () => {
    expect(evaluateMembershipGate({ status: "LEFT", isOwner: false })).toEqual({
      active: false,
      isOwner: false,
    });
  });

  it("denies an invited-but-not-active member", () => {
    expect(evaluateMembershipGate({ status: "INVITED", isOwner: false })).toEqual({
      active: false,
      isOwner: false,
    });
  });

  it("allows an active member without owner rights", () => {
    expect(evaluateMembershipGate({ status: "ACTIVE", isOwner: false })).toEqual({
      active: true,
      isOwner: false,
    });
  });

  it("allows and flags an active owner", () => {
    expect(evaluateMembershipGate({ status: "ACTIVE", isOwner: true })).toEqual({
      active: true,
      isOwner: true,
    });
  });
});

describe("isActiveDelegation", () => {
  const now = new Date("2026-07-26T12:00:00Z");
  const future = new Date("2026-07-27T12:00:00Z");
  const past = new Date("2026-07-25T12:00:00Z");

  function makeRow(overrides: Partial<DelegationRow> = {}): DelegationRow {
    return {
      permissions: ["hr:leaves:approve"],
      status: "ACTIVE",
      startsAt: past,
      endsAt: future,
      ...overrides,
    };
  }

  it("accepts an ACTIVE delegation whose endsAt is in the future", () => {
    expect(isActiveDelegation(makeRow(), now)).toBe(true);
  });

  it("rejects a delegation with status REVOKED", () => {
    expect(isActiveDelegation(makeRow({ status: "REVOKED" }), now)).toBe(false);
  });

  it("rejects a delegation that has expired (endsAt in the past)", () => {
    expect(isActiveDelegation(makeRow({ endsAt: past }), now)).toBe(false);
  });

  it("rejects a delegation that expires exactly at now (boundary)", () => {
    expect(isActiveDelegation(makeRow({ endsAt: now }), now)).toBe(false);
  });

  it("accepts a delegation that expires one millisecond in the future", () => {
    const almostExpired = new Date(now.getTime() + 1);
    expect(isActiveDelegation(makeRow({ endsAt: almostExpired }), now)).toBe(true);
  });

  it("rejects a delegation that has not started", () => {
    expect(isActiveDelegation(makeRow({ startsAt: future }), now)).toBe(false);
  });

  it("merging an active delegation's permissions into an empty map adds them at all scope", () => {
    const row = makeRow({ permissions: ["hr:leaves:approve", "hr:employees:view"] });
    const result: Record<string, import("./access.types").DataScope> = {};
    if (isActiveDelegation(row, now)) {
      for (const key of row.permissions) {
        const existing = result[key];
        result[key] = existing ? broadest(existing, "all") : "all";
      }
    }
    expect(result).toEqual({ "hr:leaves:approve": "all", "hr:employees:view": "all" });
  });

  it("merging an active delegation does not remove or downgrade existing permissions", () => {
    const result: Record<string, import("./access.types").DataScope> = {
      "hr:leaves:approve": "team",
    };
    const row = makeRow({ permissions: ["hr:leaves:approve"] });
    if (isActiveDelegation(row, now)) {
      for (const key of row.permissions) {
        const existing = result[key];
        result[key] = existing ? broadest(existing, "all") : "all";
      }
    }
    expect(result["hr:leaves:approve"]).toBe("all");
  });

  it("an expired or revoked delegation contributes no permissions to the map", () => {
    const result: Record<string, import("./access.types").DataScope> = {};
    const rows = [
      makeRow({ status: "REVOKED", permissions: ["hr:leaves:approve"] }),
      makeRow({ endsAt: past, permissions: ["hr:employees:view"] }),
    ];
    for (const row of rows) {
      if (isActiveDelegation(row, now)) {
        for (const key of row.permissions) {
          const existing = result[key];
          result[key] = existing ? broadest(existing, "all") : "all";
        }
      }
    }
    expect(result).toEqual({});
  });
});

describe("isActiveAssignment", () => {
  const now = new Date("2026-07-28T12:00:00Z");

  it("grants when expiresAt is null (permanent assignment)", () => {
    expect(isActiveAssignment({ expiresAt: null }, now)).toBe(true);
  });

  it("grants when expiresAt is one millisecond in the future", () => {
    const future = new Date(now.getTime() + 1);
    expect(isActiveAssignment({ expiresAt: future }, now)).toBe(true);
  });

  it("does not grant when expiresAt is in the past (expired assignment)", () => {
    const past = new Date(now.getTime() - 1000);
    expect(isActiveAssignment({ expiresAt: past }, now)).toBe(false);
  });

  it("does not grant when expiresAt equals now (boundary — strict greater-than)", () => {
    expect(isActiveAssignment({ expiresAt: now }, now)).toBe(false);
  });
});

function makeSelectChain(result: unknown[]): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    where: jest.fn().mockResolvedValue(result),
    innerJoin: jest.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
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
  return new AccessService(
    withTenantTxMock(db as object) as unknown as Db,
    cache as unknown as CacheService,
    entitlements as unknown as EntitlementsService,
    makeMfaPolicyStub(),
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
      if (moduleOf(permissionKey) === "hr") {
        expect(result.has(permissionKey)).toBe(false);
      } else {
        expect(result.has(permissionKey)).toBe(true);
      }
    }
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
      invalidateForOrg(o: string, k: string) {
      return this.invalidate(`${o}:${k}`);
    },
      invalidatePattern: jest.fn().mockResolvedValue(undefined),
    };
    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleMap: jest.fn().mockResolvedValue({}),
      getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    };
    const svc = new AccessService(
      db as unknown as Db,
      cache as unknown as CacheService,
      entitlements as unknown as EntitlementsService,
      makeMfaPolicyStub(),
    );
    svc.onModuleInit();

    await svc.resolveUserPermissions("org-bump", "user-bump");
    expect(db.query.accessVersions.findFirst).toHaveBeenCalledTimes(1);
    svc["membershipAccessCache"].set("org-bump:user-bump", {
      exists: true,
      active: true,
      isOwnerOrAdmin: false,
      expiresAt: Date.now() + 30_000,
    });

    currentVersion = 2;
    await bumpPermissionsVersion(db as unknown as DbOrTx, "org-bump");

    expect(svc["membershipAccessCache"].has("org-bump:user-bump")).toBe(false);
    expect(cache.invalidatePattern).not.toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledWith("org-bump:rbac:members");
    expect(cache.invalidate).toHaveBeenCalledWith(
      "org-bump:module-access:candidates",
    );
    await svc.resolveUserPermissions("org-bump", "user-bump");
    expect(db.query.accessVersions.findFirst).toHaveBeenCalledTimes(2);

    svc["versionCache"].delete("org-bump");
    cache.invalidatePattern.mockClear();
    cache.invalidate.mockClear();
    currentVersion = 3;
    await bumpPermissionsVersion(db as unknown as DbOrTx, "org-bump");
    expect(cache.invalidatePattern).not.toHaveBeenCalled();

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
        .mockReturnValueOnce(makeSelectChain([{ permissionKey: STALE_KEY }]))
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
    const svc = new AccessService(
      db1 as unknown as Db,
      cache as unknown as CacheService,
      entitlements as unknown as EntitlementsService,
      makeMfaPolicyStub(),
    );

    await svc.resolveUserPermissions("org-dedup", "user-dedup");

    const db2 = withTenantTxMock(makeDb());
    (svc as unknown as { db: unknown }).db = db2;
    cache.cached.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());
    svc["versionCache"].clear();
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

describe("AccessService.membersWithPermission", () => {
  function makeQueryChain(result: unknown[]): Record<string, jest.Mock> {
    const p = Promise.resolve(result);
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(),
      where: jest.fn(),
      innerJoin: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
      then: jest.fn().mockImplementation(
        (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) => p.then(res, rej),
      ),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    return chain;
  }

  function buildSvc(opts: {
    selectResults?: unknown[][];
    distinctResults?: unknown[][];
    isModuleEnabled?: boolean;
  }): AccessService {
    let sIdx = 0;
    let dIdx = 0;
    const sr = opts.selectResults ?? [];
    const dr = opts.distinctResults ?? [];

    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn().mockImplementation(() => makeQueryChain(sr[sIdx++] ?? [])),
      selectDistinct: jest.fn().mockImplementation(() => makeQueryChain(dr[dIdx++] ?? [])),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation(
      async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
    );

    const cache = {
      cached: jest.fn().mockImplementation(async (_k: string, fn: () => Promise<unknown>) => fn()),
      invalidate: jest.fn().mockResolvedValue(undefined),
      cachedForOrg(o: string, k: string, fn: () => Promise<unknown>, ttl?: number) {
      return this.cached(`${o}:${k}`, fn, ttl);
    },
      invalidateForOrg(o: string, k: string) {
      return this.invalidate(`${o}:${k}`);
    },
    };

    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(opts.isModuleEnabled ?? true),
      getModuleMap: jest.fn().mockResolvedValue({}),
      getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
    };

    return new AccessService(
      db as unknown as Db,
      cache as unknown as CacheService,
      entitlements as unknown as EntitlementsService,
      makeMfaPolicyStub(),
    );
  }

  const PERM = "hr:leaves:approve";

  it("returns [] immediately when the module is disabled", async () => {
    const svc = buildSvc({ isModuleEnabled: false });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([]);
  });

  it("returns [] when no member holds the permission", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [],
      ],
      distinctResults: [
        [],
        [],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([]);
  });

  it("includes org owners regardless of role grants", async () => {
    const svc = buildSvc({
      selectResults: [
        [{ userId: "owner-1", membershipId: 10 }],
        [],
      ],
      distinctResults: [
        [],
        [],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "owner-1", membershipId: 10 }]);
  });

  it("includes members with an explicit role grant via direct role assignment", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [],
      ],
      distinctResults: [
        [{ roleId: 42 }],
        [{ roleId: 42 }],
        [],
        [{ userId: "u-direct", membershipId: 20 }],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "u-direct", membershipId: 20 }]);
  });

  it("includes members who inherit the role via a principal group", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [],
      ],
      distinctResults: [
        [{ roleId: 55 }],
        [{ roleId: 55 }],
        [],
        [],
        [{ userId: "u-group", membershipId: 30 }],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "u-group", membershipId: 30 }]);
  });

  it("includes module owners", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [],
      ],
      distinctResults: [
        [],
        [],
        [{ userId: "u-modowner", membershipId: 40 }],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "u-modowner", membershipId: 40 }]);
  });

  it("excludes users explicitly denied the module", async () => {
    const svc = buildSvc({
      selectResults: [
        [{ userId: "owner-1", membershipId: 10 }],
        [],
        [{ userId: "owner-1" }],
      ],
      distinctResults: [
        [],
        [],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([]);
  });

  it("includes a member whose role uses the ROLE_DEFAULT_PERMISSIONS fallback", async () => {
    const svc = buildSvc({
      selectResults: [
        [],
        [{ roleId: 77 }],
      ],
      distinctResults: [
        [],
        [],
        [],
        [{ userId: "u-default", membershipId: 50 }],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toEqual([{ userId: "u-default", membershipId: 50 }]);
  });

  it("deduplicates a user who appears in both owner rows and role assignment rows", async () => {
    const svc = buildSvc({
      selectResults: [
        [{ userId: "u-dup", membershipId: 60 }],
        [],
      ],
      distinctResults: [
        [{ roleId: 88 }],
        [{ roleId: 88 }],
        [],
        [{ userId: "u-dup", membershipId: 60 }],
        [],
      ],
    });
    const result = await svc.membersWithPermission("org-1", PERM);
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("u-dup");
  });
});

describe("AccessService.membersWithPermission — pagination", () => {
  interface CapSvc {
    svc: AccessService;
    cachedMock: jest.Mock;
  }

  function buildCapSvc(pages: {
    data: { userId: string; membershipId: number }[];
    nextCursor: number;
    exhausted: boolean;
  }[]): CapSvc {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation(
      async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
    );

    const cachedMock = jest.fn().mockImplementation(
      async (_key: string, _fn: () => Promise<unknown>) => {
        return pages.shift() ?? { data: [], nextCursor: 0, exhausted: true };
      },
    );

    const cache = {
      cached: cachedMock,
      invalidate: jest.fn().mockResolvedValue(undefined),
      cachedForOrg(o: string, k: string, fn: () => Promise<unknown>, ttl?: number) {
      return this.cached(`${o}:${k}`, fn, ttl);
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

    return {
      svc: new AccessService(
        db as unknown as Db,
        cache as unknown as CacheService,
        entitlements as unknown as EntitlementsService,
        makeMfaPolicyStub(),
      ),
      cachedMock,
    };
  }

  it("loads every page when no explicit limit is supplied", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      userId: `u-${i}`,
      membershipId: i,
    }));
    const { svc, cachedMock } = buildCapSvc([
      { data: firstPage, nextCursor: 100, exhausted: false },
      {
        data: [{ userId: "u-100", membershipId: 100 }],
        nextCursor: 101,
        exhausted: true,
      },
    ]);

    const result = await svc.membersWithPermission(
      "org-1",
      "settings:manage",
    );

    expect(result).toHaveLength(101);
    expect(cachedMock).toHaveBeenCalledTimes(2);
    expect(String(cachedMock.mock.calls[0]?.[0])).toContain(":a0:l100");
    expect(String(cachedMock.mock.calls[1]?.[0])).toContain(":a100:l100");
  });

  it("stops at an explicit caller limit without a silent default cap", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      userId: `u-${i}`,
      membershipId: i,
    }));
    const { svc, cachedMock } = buildCapSvc([
      { data: firstPage, nextCursor: 100, exhausted: false },
    ]);

    const result = await svc.membersWithPermission(
      "org-1",
      "settings:manage",
      { limit: 50 },
    );

    expect(result).toHaveLength(50);
    expect(cachedMock).toHaveBeenCalledTimes(1);
  });
});
