/**
 * Findings register #48 — a failed RBAC read used to degrade a user to zero
 * permissions, silently.
 *
 * `safeAccessTableRead` swallowed anything `isMissingRelationError` matched and
 * returned the caller's empty fallback. That predicate is a substring test for
 * "does not exist", so it also matched `column ... does not exist` (schema drift
 * mid-deploy), `role ... does not exist` and `database ... does not exist` — and
 * `computeUserPermissions` reads an empty grants list as "this user holds no
 * permissions". The empty result was then cached for the snapshot window, so one
 * transient failure took a user's permissions away for seconds with nothing but a
 * once-per-process warn. On the denied-modules read the same fallback failed
 * OPEN: an empty list restores modules the org took away.
 *
 * Every read now throws. The reader takes no fallback argument at all, so the
 * silent path cannot be reintroduced by passing one.
 */

jest.mock("../../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { makeMembershipStateStub } from "../../../../test/helpers/membership-state-stub";
import { AccessService } from "../access.service";
import { AccessVersionCache } from "../access-version-cache";
import { DeniedModulesResolver } from "../denied-modules.resolver";
import { UserModuleAccessService } from "../user-module-access.service";
import { drainRolePermissionGrants, drainUserPermissionGrants } from "../access-grant-drains";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EntitlementsService } from "../entitlements.service";
import { makeMfaPolicyStub } from "../../../../test/helpers/mfa-policy-stub";
import { moduleAvailability, moduleAvailabilityResolver } from "../../../common/rbac/module-availability";
import { isCoreModuleKey } from "../entitlements.service";

function resolvingChain(result: unknown[]): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    where: jest.fn(),
    innerJoin: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
  };
  for (const key of ["from", "where", "innerJoin", "orderBy"]) chain[key]?.mockReturnValue(chain);
  return chain;
}

function rejectingChain(error: unknown): Record<string, jest.Mock> {
  const chain = resolvingChain([]);
  chain.limit = jest.fn().mockRejectedValue(error);
  return chain;
}

function withTenantTxMock<T extends object>(db: T): T {
  const mutable = db as T & { execute?: jest.Mock; transaction?: jest.Mock };
  mutable.execute = jest.fn().mockResolvedValue(undefined);
  mutable.transaction = jest
    .fn()
    .mockImplementation(async (fn: (tx: T) => Promise<unknown>) => fn(db));
  return db;
}

function buildService(db: unknown): AccessService {
  const cache = {
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockResolvedValue(undefined),
    cachedForOrg(o: string, k: string, fn: () => Promise<unknown>) {
      return this.cached(`${o}:${k}`, fn);
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
    isCoreModule: jest.fn().mockReturnValue(false),
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

function dbWithFirstReadRejecting(error: unknown, select: jest.Mock) {
  return {
    query: {
      accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 1, role: "MEMBER" }),
      },
    },
    select,
  };
}

describe("AccessService.resolveUserPermissions — a failed RBAC read throws", () => {
  const cases: ReadonlyArray<[string, unknown]> = [
    ["a column that does not exist (schema drift mid-deploy)", { code: "42703", message: 'column "expires_at" does not exist' }],
    ["a genuinely missing relation", { code: "42P01", message: 'relation "role_assignments" does not exist' }],
    ["a role that does not exist", { code: "28000", message: 'role "streamline_app" does not exist' }],
    ["a wrapped message-only error", new Error('relation "user_permission_grants" does not exist')],
    ["a transient connection failure", new Error("Connection terminated unexpectedly")],
  ];

  for (const [label, error] of cases) {
    it(`rejects rather than resolving to an empty permission set on ${label}`, async () => {
      const select = jest.fn().mockReturnValue(rejectingChain(error));
      const service = buildService(dbWithFirstReadRejecting(error, select));

      await expect(service.resolveUserPermissions("org-1", "user-1")).rejects.toBeDefined();
    });
  }

  it("caches nothing on failure, so the next request re-reads instead of serving an empty set", async () => {
    const error = { code: "42703", message: 'column "scope" does not exist' };
    const select = jest.fn().mockReturnValue(rejectingChain(error));
    const service = buildService(dbWithFirstReadRejecting(error, select));

    await expect(service.resolveUserPermissions("org-1", "user-1")).rejects.toBeDefined();
    const callsAfterFirst = select.mock.calls.length;
    await expect(service.resolveUserPermissions("org-1", "user-1")).rejects.toBeDefined();

    expect(select.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe("DeniedModulesResolver — an unreadable denial list never resolves to 'nothing is denied'", () => {
  it("rejects instead of failing open with an empty denied set", async () => {
    const error = { code: "42703", message: 'column "enabled" does not exist' };
    const db = withTenantTxMock({ select: jest.fn().mockReturnValue(rejectingChain(error)) });
    const resolver = new DeniedModulesResolver(
      () => db as unknown as Db,
      (read) => read() as Promise<never>,
      () => Promise.resolve(1),
      () => false,
    );

    await expect(resolver.resolve("org-1", "user-1")).rejects.toBeDefined();
  });
});

describe("DeniedModulesResolver — structural access survives legacy deny rows", () => {
  function serviceForRow(role: string, isOwner: boolean): AccessService {
    return buildService({
      query: { accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      select: jest.fn().mockReturnValue(resolvingChain([
        { moduleKey: "build", role, isOwner },
      ])),
    });
  }

  async function availabilityFor(service: AccessService, enabled: boolean) {
    return moduleAvailability(
      moduleAvailabilityResolver(
        {
          isCoreModule: isCoreModuleKey,
          getModuleMap: async () => ({ build: enabled }),
          getPlanLockedModules: async () => [],
        },
        { getUserDeniedModules: (orgId, userId) => service.getUserDeniedModules(orgId, userId) },
      ),
      "org-1",
      "user-1",
      "build",
    );
  }

  it.each([
    ["OWNER", true],
    ["ORG_ADMIN", false],
  ])("ignores a historical deny for structural %s and keeps enabled Build available", async (role, isOwner) => {
    const service = serviceForRow(role, isOwner);

    await expect(service.getUserDeniedModules("org-1", "user-1"))
      .resolves.toEqual(new Set());
    await expect(availabilityFor(service, true))
      .resolves.toEqual({ available: true });
    await expect(availabilityFor(service, false))
      .resolves.toEqual({ available: false, reason: "org-disabled" });
  });

  it("keeps a revoked Org Member denied even when Build is enabled", async () => {
    const service = serviceForRow("MEMBER", false);

    await expect(service.getUserDeniedModules("org-1", "user-1"))
      .resolves.toEqual(new Set(["build"]));
    await expect(availabilityFor(service, true))
      .resolves.toEqual({ available: false, reason: "user-denied" });
  });
});

describe("UserModuleAccessService.getUserDeniedModules — the same twin swallow, removed", () => {
  function rejectingDb(error: unknown): Db {
    const where = jest.fn().mockReturnValue({ limit: jest.fn().mockRejectedValue(error) });
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const select = jest.fn().mockReturnValue({ from });
    const innerTx = { select, execute: jest.fn().mockResolvedValue([]) };
    return {
      select,
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(innerTx)),
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue({ permissionsVersion: 1 }) },
      },
    } as unknown as Db;
  }

  it("rejects rather than resolving to an empty denied set, which would restore every module the org took away", async () => {
    const db = rejectingDb({ code: "42P01", message: 'relation "user_module_access" does not exist' });
    const service = new UserModuleAccessService(
      db,
      { isCoreModule: jest.fn().mockReturnValue(false) } as unknown as EntitlementsService,
      {} as unknown as CacheService,
      new AccessVersionCache(db),
    );

    await expect(service.getUserDeniedModules("org-1", "user-1")).rejects.toBeDefined();
  });
});

describe("the reader takes no fallback, so an empty result is unrepresentable", () => {
  it("drainRolePermissionGrants calls the reader with exactly one argument", async () => {
    const read = jest.fn().mockImplementation((r: () => PromiseLike<unknown>) => r());
    const db = { select: jest.fn().mockReturnValue(resolvingChain([])) };

    await drainRolePermissionGrants(db as unknown as Db, read as never, "org-1", [1]);

    expect(read).toHaveBeenCalled();
    expect(read.mock.calls[0]).toHaveLength(1);
  });

  it("drainUserPermissionGrants calls the reader with exactly one argument", async () => {
    const read = jest.fn().mockImplementation((r: () => PromiseLike<unknown>) => r());
    const db = { select: jest.fn().mockReturnValue(resolvingChain([])) };

    await drainUserPermissionGrants(db as unknown as Db, read as never, "org-1", 1);

    expect(read).toHaveBeenCalled();
    expect(read.mock.calls[0]).toHaveLength(1);
  });

  it("propagates a rejection out of the drain instead of returning the rows read so far", async () => {
    const read = jest.fn().mockRejectedValue(new Error("Connection terminated unexpectedly"));

    await expect(
      drainUserPermissionGrants({ select: jest.fn() } as unknown as Db, read as never, "org-1", 1),
    ).rejects.toThrow("Connection terminated unexpectedly");
  });
});
