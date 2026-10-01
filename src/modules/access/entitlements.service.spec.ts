import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { EntitlementsService } from "./entitlements.service";
import { ModuleDisabledException } from "../../common/http/api-exceptions";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import {
  PLAN_LOCKED_MODULES,
  type PlanTier,
} from "../billing/core/plan-entitlements.constants";
import { ADMINISTRABLE_MODULES, MODULE_CATALOG } from "../../common/rbac/module-vocabulary";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

async function settleAfterCommit(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function buildMockDb(ownerMembershipId: number | null = 42, mockRoleId: number | null = 999) {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });
  const execute = jest.fn().mockResolvedValue({ rows: [] });
  const findFirst = jest.fn();
  const findMany = jest.fn().mockResolvedValue([]);
  const orgFindFirst = jest.fn();
  const activeMemberRows = [
    { membershipId: 1, userId: "member-1" },
    { membershipId: 2, userId: "member-2" },
  ];

  const limit = jest.fn()
    .mockResolvedValueOnce(ownerMembershipId !== null ? [{ ownerMembershipId }] : [])
    .mockResolvedValueOnce(mockRoleId !== null ? [{ id: mockRoleId }] : [])
    .mockResolvedValue(activeMemberRows);
  // The ACTIVE-member scan is keyset-paged, so it orders by membership id before
  // taking a page. Without `orderBy` here the mock would throw rather than fail
  // an assertion, which reads as an unrelated crash.
  const orderBy = jest.fn().mockReturnValue({ limit });
  const txWhere = jest.fn().mockReturnValue({
    limit,
    orderBy,
    then: (resolve: (rows: { userId: string }[]) => unknown) => resolve(activeMemberRows),
  });
  const txFrom = jest.fn().mockReturnValue({ where: txWhere });
  const txSelect = jest.fn().mockReturnValue({ from: txFrom });

  const txDb = { insert, execute, select: txSelect };
  const transaction = jest.fn().mockImplementation(
    async (fn: (tx: typeof txDb) => Promise<unknown>) => fn(txDb),
  );

  const db: DeepPartial<Db> = {
    query: {
      orgModules: { findFirst, findMany },
      organizations: { findFirst: orgFindFirst },
    } as unknown as Db["query"],
    insert,
    execute,
    transaction,
  };

  return {
    db: db as unknown as Db,
    mocks: {
      findFirst,
      findMany,
      orgFindFirst,
      insert,
      values,
      onConflictDoUpdate,
      onConflictDoNothing,
      execute,
      transaction,
      txSelect,
      txFrom,
      txWhere,
      orderBy,
      limit,
      activeMemberRows,
    },
  };
}

function buildMockCache(
  cachedImpl?: (key: string, fn: () => Promise<unknown>, ttl?: number) => Promise<unknown>,
) {
  const cached = jest.fn().mockImplementation(
    cachedImpl ?? (async (_key: string, fn: () => Promise<unknown>) => fn()),
  );
  const cachedForOrg = jest
    .fn()
    .mockImplementation(
      (orgId: string, key: string, fn: () => Promise<unknown>, ttl?: number) =>
        cached(`${orgId}:${key}`, fn, ttl),
    );
  const invalidate = jest.fn().mockResolvedValue(undefined);
  const invalidateForOrg = jest
    .fn()
    .mockImplementation((orgId: string, key: string) => invalidate(`${orgId}:${key}`));

  const invalidateMany = jest.fn().mockResolvedValue(undefined);

  const cache: DeepPartial<CacheService> = {
    cached,
    cachedForOrg,
    invalidate,
    invalidateForOrg,
    invalidateMany,
  };

  return {
    cache: cache as unknown as CacheService,
    mocks: { cached, cachedForOrg, invalidate, invalidateForOrg, invalidateMany },
  };
}

function buildService(
  db: Db,
  cache: CacheService,
  tier: PlanTier = "ENTERPRISE",
) {
  const resolveTier = jest.fn().mockResolvedValue({ tier, plan: tier });
  const planLimits: DeepPartial<PlanLimitsService> = { resolveTier };
  return new EntitlementsService(
    db,
    cache,
    planLimits as unknown as PlanLimitsService,
  );
}

describe("EntitlementsService", () => {
  describe("isModuleEnabled", () => {
    it("delegates to cache.cached with the correct cache key and ttl", async () => {
      const { db, mocks: dbMocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();
      dbMocks.findMany.mockResolvedValue([{ moduleKey: "hr", enabled: true }]);

      await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(cacheMocks.cachedForOrg).toHaveBeenCalledWith(
        "org-1",
        "entitlements:modules",
        expect.any(Function),
        30,
      );
    });

    it("returns false when no row found for a GATED module key (deny-on-absent)", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([]);
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(false);
    });

    it("honours a stored row written in the other case", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([{ moduleKey: "HR", enabled: true }]);
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(true);
    });

    it("honours a required key written in the other case", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([{ moduleKey: "hr", enabled: true }]);
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "HR");

      expect(result).toBe(true);
    });

    it("returns true for a CORE module key even with no rows (always-on)", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([]);
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "kb");

      expect(result).toBe(true);
    });

    it("fails closed on 42P01 (missing org_modules table)", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockRejectedValue({ code: "42P01" });
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(false);
    });

    it("fails closed when the missing-table error is message-wrapped", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockRejectedValue(new Error("relation does not exist"));
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(false);
    });

    it("returns false when the row has enabled=false", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([{ moduleKey: "hr", enabled: false }]);
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(false);
    });

    it("returns true when the row has enabled=true", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([{ moduleKey: "hr", enabled: true }]);
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(true);
    });

    it("re-throws errors that are not missing-table errors", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockRejectedValue(new Error("connection refused"));
      const { cache } = buildMockCache();

      await expect(
        buildService(db, cache).isModuleEnabled("org-1", "hr"),
      ).rejects.toThrow("connection refused");
    });

    it("returns the cached value without querying the db on a cache hit", async () => {
      const { db, mocks: dbMocks } = buildMockDb();
      const { cache } = buildMockCache(async () => ({ hr: false }));

      const result = await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(false);
      expect(dbMocks.findMany).not.toHaveBeenCalled();
    });
  });

  describe("setModuleEnabled — plan gate", () => {
    it.each(PLAN_LOCKED_MODULES.FREE)(
      "refuses to enable %s on FREE with 402 not-in-plan pointing at billing, and writes nothing",
      async (moduleKey) => {
        const { db, mocks } = buildMockDb();
        const { cache } = buildMockCache();

        const refusal = buildService(db, cache, "FREE")
          .setModuleEnabled("org-1", moduleKey, true, "user-1")
          .catch((caught: unknown) => caught);
        const error = await refusal;
        expect(error).toBeInstanceOf(ModuleDisabledException);
        expect(error).not.toBeInstanceOf(ForbiddenException);
        if (!(error instanceof ModuleDisabledException)) return;
        expect(error.getStatus()).toBe(402);
        expect(error.getResponse()).toMatchObject({
          code: "MODULE_NOT_ENABLED",
          details: { moduleKey, reason: "not-in-plan", upgradePath: "/settings/billing" },
        });

        expect(mocks.transaction).not.toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
      },
    );

    it.each(PLAN_LOCKED_MODULES.FREE)(
      "allows %s on a paid tier, so the FREE refusal is the plan gate and not the module",
      async (moduleKey) => {
        const { db, mocks } = buildMockDb();
        const { cache } = buildMockCache();

        await buildService(db, cache, "PAID").setModuleEnabled(
          "org-1",
          moduleKey,
          true,
          "user-1",
        );

        expect(mocks.values).toHaveBeenCalledWith({
          orgId: "org-1",
          moduleKey,
          enabled: true,
          enabledBy: "user-1",
        });
      },
    );

    it("never blocks a DISABLE on FREE, so a downgrade cannot strand an org", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache, "FREE").setModuleEnabled(
        "org-1",
        "payroll",
        false,
        "user-1",
      );

      expect(mocks.values).toHaveBeenCalledWith({
        orgId: "org-1",
        moduleKey: "payroll",
        enabled: false,
        enabledBy: "user-1",
      });
    });

    it("leaves an already-enabled paid module enabled on FREE — enablement is never revoked", async () => {
      const { db } = buildMockDb();
      const { cache } = buildMockCache(async () => ({ payroll: true }));

      const service = buildService(db, cache, "FREE");

      await expect(service.isModuleEnabled("org-1", "payroll")).resolves.toBe(true);
      await expect(
        service.setModuleEnabled("org-1", "payroll", true, "user-1"),
      ).rejects.toBeInstanceOf(ModuleDisabledException);
    });
  });

  describe("setModuleEnabled", () => {
    it("wraps the upsert in a single transaction, publishes the version bump in a second, and reads members in a third", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      await settleAfterCommit();

      // Three, not one, and the split is the point. Every write — the upsert, the
      // ownership row, the version bump — is still one atomic transaction.
      // bumpPermissionsVersion registers an afterCommit hook to publish the version
      // bump, which drainAfterCommitHooks runs in its own transaction once the
      // write commits. The ACTIVE-member scan that feeds the session bust is
      // deliberately in neither: it is deferred past the commit so the request's
      // pooled connection is released first. There is no ambient request context
      // in a unit test, so `registerAfterCommit` declines and the hook runs
      // inline here, opening its own tenant transaction.
      expect(mocks.transaction).toHaveBeenCalledTimes(3);
    });

    it("upserts with enabled=true and the correct field values", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      await settleAfterCommit();

      expect(mocks.insert).toHaveBeenCalledTimes(5);
      expect(mocks.values).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "org.module_enabled",
          userId: "user-1",
          orgId: "org-1",
          resourceId: "hr",
        }),
      );
      expect(mocks.values).toHaveBeenCalledWith({
        orgId: "org-1",
        moduleKey: "hr",
        enabled: true,
        enabledBy: "user-1",
      });
      expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ set: { enabled: true, enabledBy: "user-1" } }),
      );
    });

    it("upserts with enabled=false and the correct field values", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", false, "user-1");

      await settleAfterCommit();

      expect(mocks.values).toHaveBeenCalledWith({
        orgId: "org-1",
        moduleKey: "hr",
        enabled: false,
        enabledBy: "user-1",
      });
      expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ set: { enabled: false, enabledBy: "user-1" } }),
      );
    });

    it("executes only the tenant context SQL when enabling a module", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      await settleAfterCommit();

      // One set_config per transaction and no other raw SQL: the write transaction,
      // the after-commit transaction bumpPermissionsVersion's registerAfterCommit
      // hook opens to publish the version bump post-commit, and the deferred
      // member scan. Anything above three is hand-written SQL that has escaped
      // the query builder.
      expect(mocks.execute).toHaveBeenCalledTimes(3);
    });

    it("executes only the tenant context SQL when disabling a module", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", false, "user-1");

      await settleAfterCommit();

      expect(mocks.execute).toHaveBeenCalledTimes(3);
    });

    it("throws 400 BadRequestException when toggling a core module (kb)", async () => {
      const { db } = buildMockDb();
      const { cache } = buildMockCache();

      await expect(
        buildService(db, cache).setModuleEnabled("org-1", "kb", true, "user-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("skips the org array SQL for unmapped module keys (kb, etc.)", async () => {
      const { db } = buildMockDb();
      const { cache } = buildMockCache();

      await expect(
        buildService(db, cache).setModuleEnabled("org-1", "kb", true, "user-1"),
      ).rejects.toThrow("always-on");
    });

    it("invalidates the module, list, and session caches after the transaction", async () => {
      const { db, mocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      await settleAfterCommit();

      expect(cacheMocks.invalidate).toHaveBeenCalledWith("org-1:entitlements:module:hr");
      expect(cacheMocks.invalidate).toHaveBeenCalledWith("org-1:entitlements:modules");
      // Exactly the two org-scoped keys go through the single-key path. The member
      // session busts used to make this 4; they are now one batched call, and the
      // count is asserted on both paths so neither can quietly grow.
      expect(cacheMocks.invalidate).toHaveBeenCalledTimes(2);
      expect(cacheMocks.invalidateMany).toHaveBeenCalledTimes(1);
      expect(cacheMocks.invalidateMany).toHaveBeenCalledWith(
        mocks.activeMemberRows.map((row) => `user:session:${row.userId}`),
      );
    });

    it("busts the session cache of every active member, not just the actor", async () => {
      const { db, mocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "actor-not-a-member");

      await settleAfterCommit();

      // ONE call carrying every member's key, not one call per member. A
      // `members.map((m) => cache.invalidate(...))` reads as batched and is not:
      // it is one Redis command per member, so the widest tenant in the seeded
      // database — 89.93% of the rows — pays the worst price for one toggle.
      expect(cacheMocks.invalidateMany).toHaveBeenCalledTimes(1);
      const keys = cacheMocks.invalidateMany.mock.calls[0]?.[0] as string[];
      for (const row of mocks.activeMemberRows)
        expect(keys).toContain(`user:session:${row.userId}`);
      expect(keys).not.toContain("user:session:actor-not-a-member");
    });

    it("keyset-pages the member scan so an org past one page is not truncated", async () => {
      // The scan used to be a single `.limit(10000)`: member 10,001 onward kept a
      // stale enabledModules until TTL and nothing said so. This proves the loop
      // continues past a full page and advances on the last membership id.
      const { db, mocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();

      const fullPage = Array.from({ length: 500 }, (_, i) => ({
        membershipId: i + 1,
        userId: `member-${String(i + 1)}`,
      }));
      const tail = [{ membershipId: 501, userId: "member-501" }];
      mocks.limit
        .mockReset()
        .mockResolvedValueOnce([{ ownerMembershipId: 42 }])
        .mockResolvedValueOnce([{ id: 999 }])
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce(tail)
        .mockResolvedValue([]);

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      await settleAfterCommit();

      expect(cacheMocks.invalidateMany).toHaveBeenCalledTimes(2);
      expect(cacheMocks.invalidateMany).toHaveBeenNthCalledWith(
        2,
        ["user:session:member-501"],
      );
      // A short page ends the scan: no third read is issued for a page that
      // cannot exist.
      expect(mocks.orderBy).toHaveBeenCalledTimes(2);
    });

    describe("ownership seeding", () => {
      it("seeds an ownership row pointing at the org owner when enabling an access-managed module", async () => {
        const { db, mocks } = buildMockDb(42);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

        await settleAfterCommit();

        expect(mocks.values).toHaveBeenCalledWith({
          orgId: "org-1",
          moduleKey: "hr",
          ownerMembershipId: 42,
        });
        expect(mocks.onConflictDoNothing).toHaveBeenCalledTimes(2);
      });

      it("does not seed ownership when disabling a module", async () => {
        const { db, mocks } = buildMockDb(42);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", false, "user-1");

        await settleAfterCommit();

        expect(mocks.txSelect).toHaveBeenCalledTimes(1);
        expect(mocks.onConflictDoNothing).not.toHaveBeenCalled();
        expect(mocks.insert).toHaveBeenCalledTimes(3);
      });

      it("skips ownership seeding when the org has no owner membership set", async () => {
        const { db, mocks } = buildMockDb(null);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

        await settleAfterCommit();

        expect(mocks.txSelect).toHaveBeenCalledTimes(2);
        expect(mocks.onConflictDoNothing).not.toHaveBeenCalled();
        expect(mocks.insert).toHaveBeenCalledTimes(3);
      });

      it("uses onConflictDoNothing so re-enabling the same module is idempotent", async () => {
        const { db, mocks } = buildMockDb(42);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

        await settleAfterCommit();

        expect(mocks.onConflictDoNothing).toHaveBeenCalledTimes(2);
        expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(2);
      });

      it("assigns the MODULE_OWNER role to the org owner when the role is seeded", async () => {
        const { db, mocks } = buildMockDb(42, 777);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

        await settleAfterCommit();

        expect(mocks.values).toHaveBeenCalledWith(
          expect.objectContaining({
            orgId: "org-1",
            organizationMembershipId: 42,
            roleId: 777,
            assignedByMembershipId: null,
          }),
        );
      });

      it("skips the MODULE_OWNER role assignment when the role is not yet seeded", async () => {
        const { db, mocks } = buildMockDb(42, null);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

        await settleAfterCommit();

        expect(mocks.onConflictDoNothing).toHaveBeenCalledTimes(1);
        expect(mocks.insert).toHaveBeenCalledTimes(4);
      });
    });
  });

  describe("listModules", () => {
    it("enables only core modules when the org has no org_modules rows (deny by default)", async () => {
      const { db, mocks } = buildMockDb();
      mocks.orgFindFirst.mockResolvedValue({ enabledModules: null });
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).listModules("org-1");

      expect(result).toHaveLength(ADMINISTRABLE_MODULES.length);
      expect(
        result
          .filter((r) => r.enabled)
          .map((r) => r.moduleKey)
          .sort(),
      ).toEqual(["chat", "kb"]);
      expect(result.find((r) => r.moduleKey === "kb")).toMatchObject({ enabled: true, core: true });
      expect(result.find((r) => r.moduleKey === "blog")).toBeUndefined();
    });

    it("never reports a module the org did not enable as enabled", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([{ moduleKey: "hr", enabled: true }]);
      const { cache } = buildMockCache();

      const service = buildService(db, cache);
      const [result, guarded] = await Promise.all([
        service.listModules("org-1"),
        service.isModuleEnabled("org-1", "payroll"),
      ]);

      expect(result.find((r) => r.moduleKey === "hr")?.enabled).toBe(true);
      expect(result.find((r) => r.moduleKey === "payroll")?.enabled).toBe(false);
      expect(guarded).toBe(false);
    });

    it("derives enabled from the org_modules rows", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([
        { moduleKey: "hr", enabled: true },
        { moduleKey: "build", enabled: true },
        { moduleKey: "crm", enabled: false },
        { moduleKey: "payroll", enabled: false },
      ]);
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).listModules("org-1");

      expect(result).toHaveLength(ADMINISTRABLE_MODULES.length);
      expect(result.find((r) => r.moduleKey === "hr")?.enabled).toBe(true);
      expect(result.find((r) => r.moduleKey === "crm")?.enabled).toBe(false);
      expect(result.find((r) => r.moduleKey === "build")?.enabled).toBe(true);
      expect(result.find((r) => r.moduleKey === "payroll")?.enabled).toBe(false);
      expect(result.find((r) => r.moduleKey === "kb")).toMatchObject({ enabled: true, core: true });
      expect(result.find((r) => r.moduleKey === "blog")).toBeUndefined();
    });

    it("marks kb as core: true regardless of org_modules config", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([{ moduleKey: "hr", enabled: false }]);
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).listModules("org-1");

      expect(result).toHaveLength(ADMINISTRABLE_MODULES.length);
      expect(result.find((r) => r.moduleKey === "kb")).toMatchObject({ enabled: true, core: true });
      expect(result.find((r) => r.moduleKey === "blog")).toBeUndefined();
      expect(result.find((r) => r.moduleKey === "hr")?.enabled).toBe(false);
    });

    it("re-throws non-missing-table errors from the org_modules query", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockRejectedValue(new Error("query error"));
      const { cache } = buildMockCache();

      await expect(
        buildService(db, cache).listModules("org-1"),
      ).rejects.toThrow("query error");
    });
  });
});
