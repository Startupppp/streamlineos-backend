import {
  AccessService,
  broadest,
  evaluateMembershipGate,
  isActiveDelegation,
  isActiveAssignment,
  isInternalModule,
  moduleOf,
  type DelegationRow,
} from "./access.service";
import type { DataScope } from "./access.types";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { EntitlementsService } from "./entitlements.service";
import { bumpPermissionsVersion, type DbOrTx } from "../../common/rbac/access-invalidate";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";

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

describe("isInternalModule", () => {
  it("treats settings and self as internal", () => {
    expect(isInternalModule("settings")).toBe(true);
    expect(isInternalModule("self")).toBe(true);
  });

  it("treats feature modules as non-internal", () => {
    expect(isInternalModule("hr")).toBe(false);
    expect(isInternalModule("crm")).toBe(false);
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

function buildService(db: unknown): AccessService {
  const cache = {
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    getModuleMap: jest.fn().mockResolvedValue({}),
  };
  return new AccessService(
    db as unknown as Db,
    cache as unknown as CacheService,
    entitlements as unknown as EntitlementsService,
  );
}

describe("AccessService.resolveUserPermissions", () => {
  it("resolves to an empty map for an active member with no role assignments (deny-by-default)", async () => {
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
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-1");

    expect(result.size).toBe(0);
  });

  it("resolves role grants for an active member with a role_assignments row", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 2 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 10 }]))
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
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-uuid-1" }]))
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

  it("group membership with no group_role_assignments contributes no permissions", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 6 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-uuid-2" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-6");

    expect(result.size).toBe(0);
  });

  it("merges group-inherited role grants with direct role grants (broadest scope wins)", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 7 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 30 }]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "group-uuid-3" }]))
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

  it("returns empty permissions when all role assignments are revoked (single-source revocation is complete)", async () => {
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
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-3");

    expect(result.size).toBe(0);
  });

  it("returns empty permissions when the DB returns no rows after filtering expired assignments", async () => {
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
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-1", "user-4");

    expect(result.size).toBe(0);
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
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ moduleKey: "hr" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-owner", "user-owner");

    expect(result.size).toBeGreaterThan(0);
    expect(result.get("hr:employees:view")).toBe("all");
    for (const [key] of result) {
      expect(key.startsWith("hr:")).toBe(true);
    }
  });

  it("a user-denied module yields no permissions for its module owner (strip step still runs post-ownership-grant)", async () => {
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
        .mockReturnValueOnce(makeSelectChain([{ moduleKey: "hr" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ moduleKey: "hr" }])),
    };

    const result = await buildService(db).resolveUserPermissions("org-owner", "user-owner");

    expect(result.size).toBe(0);
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
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue(selectChain),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    const cache = {
      cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleMap: jest.fn().mockResolvedValue({}),
    };
    const svc = new AccessService(
      db as unknown as Db,
      cache as unknown as CacheService,
      entitlements as unknown as EntitlementsService,
    );
    svc.onModuleInit();

    await svc.resolveUserPermissions("org-bump", "user-bump");
    expect(db.query.accessVersions.findFirst).toHaveBeenCalledTimes(1);

    currentVersion = 2;
    await bumpPermissionsVersion(db as unknown as DbOrTx, "org-bump");

    await svc.resolveUserPermissions("org-bump", "user-bump");
    expect(db.query.accessVersions.findFirst).toHaveBeenCalledTimes(2);

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
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 50 }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: 50, slug: "STALE_ROLE" }]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 50, permissionKey: STALE_KEY, scope: "all" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-stale", "user-stale");

    expect(result.has(STALE_KEY)).toBe(false);
    expect(result.size).toBe(0);
  });

  it("a known role-grant key still resolves normally when accompanied by a stale key", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 11 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 51 }]))
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
    expect(result.size).toBe(1);
  });

  it("a stale key in a delegation row is dropped and does not appear in the resolved map", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 12 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ permissions: [STALE_KEY] }]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions("org-del", "user-del");

    expect(result.has(STALE_KEY)).toBe(false);
    expect(result.size).toBe(0);
  });

  it("the same stale key triggers the warning log only once across multiple resolve calls (per-instance dedup)", async () => {
    const makeDb = () => ({
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 13 }),
        },
        userPermissions: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 52 }]))
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
    };
    const entitlements = {
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleMap: jest.fn().mockResolvedValue({}),
    };
    const logWarnSpy = jest.spyOn(
      require("../../common/logger/logger.service").logger,
      "warn",
    );
    logWarnSpy.mockImplementation(() => undefined);

    const db1 = makeDb();
    const svc = new AccessService(
      db1 as unknown as Db,
      cache as unknown as CacheService,
      entitlements as unknown as EntitlementsService,
    );

    await svc.resolveUserPermissions("org-dedup", "user-dedup");

    const db2 = makeDb();
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
