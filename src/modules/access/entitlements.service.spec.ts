import { BadRequestException } from "@nestjs/common";
import { EntitlementsService } from "./entitlements.service";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import { ADMINISTRABLE_MODULES, MODULE_CATALOG } from "../../common/rbac/module-vocabulary";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function buildMockDb(ownerMembershipId: number | null = 42, mockRoleId: number | null = 999) {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });
  const execute = jest.fn().mockResolvedValue({ rows: [] });
  const findFirst = jest.fn();
  const findMany = jest.fn().mockResolvedValue([]);
  const orgFindFirst = jest.fn();

  const limit = jest.fn()
    .mockResolvedValueOnce(ownerMembershipId !== null ? [{ ownerMembershipId }] : [])
    .mockResolvedValue(mockRoleId !== null ? [{ id: mockRoleId }] : []);
  const txWhere = jest.fn().mockReturnValue({ limit });
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
      limit,
    },
  };
}

function buildMockCache(
  cachedImpl?: (key: string, fn: () => Promise<unknown>, ttl?: number) => Promise<unknown>,
) {
  const cached = jest.fn().mockImplementation(
    cachedImpl ?? (async (_key: string, fn: () => Promise<unknown>) => fn()),
  );
  const invalidate = jest.fn().mockResolvedValue(undefined);

  const cache: DeepPartial<CacheService> = { cached, invalidate };

  return { cache: cache as unknown as CacheService, mocks: { cached, invalidate } };
}

function buildService(
  db: Db,
  cache: CacheService,
  migrationMode: "off" | "degrade" = "off",
) {
  const resolveTier = jest.fn().mockResolvedValue({ tier: "ENTERPRISE", plan: "ENTERPRISE" });
  const planLimits: DeepPartial<PlanLimitsService> = { resolveTier };
  return new EntitlementsService(
    db,
    cache,
    planLimits as unknown as PlanLimitsService,
    { RBAC_MIGRATION_MODE: migrationMode },
  );
}

describe("EntitlementsService", () => {
  describe("isModuleEnabled", () => {
    it("delegates to cache.cached with the correct cache key and ttl", async () => {
      const { db, mocks: dbMocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();
      dbMocks.findMany.mockResolvedValue([{ moduleKey: "hr", enabled: true }]);

      await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(cacheMocks.cached).toHaveBeenCalledWith(
        "entitlements:modules:org-1",
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

    it("fails closed on 42P01 when migration mode is off", async () => {
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

    it("degrades only when migration mode is explicitly enabled", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockRejectedValue({ code: "42P01" });
      const { cache } = buildMockCache();

      const result = await buildService(
        db,
        cache,
        "degrade",
      ).isModuleEnabled("org-1", "hr");

      expect(result).toBe(true);
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

  describe("setModuleEnabled", () => {
    it("wraps the upsert in a single transaction", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      expect(mocks.transaction).toHaveBeenCalledTimes(1);
    });

    it("upserts with enabled=true and the correct field values", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      expect(mocks.insert).toHaveBeenCalledTimes(4);
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

      expect(mocks.execute).toHaveBeenCalledTimes(1);
    });

    it("executes only the tenant context SQL when disabling a module", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", false, "user-1");

      expect(mocks.execute).toHaveBeenCalledTimes(1);
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
      const { db } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      expect(cacheMocks.invalidate).toHaveBeenCalledWith("entitlements:module:org-1:hr");
      expect(cacheMocks.invalidate).toHaveBeenCalledWith("entitlements:modules:org-1");
      expect(cacheMocks.invalidate).toHaveBeenCalledWith("user:session:user-1");
      expect(cacheMocks.invalidate).toHaveBeenCalledTimes(3);
    });

    describe("ownership seeding", () => {
      it("seeds an ownership row pointing at the org owner when enabling an access-managed module", async () => {
        const { db, mocks } = buildMockDb(42);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

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

        expect(mocks.txSelect).not.toHaveBeenCalled();
        expect(mocks.onConflictDoNothing).not.toHaveBeenCalled();
        expect(mocks.insert).toHaveBeenCalledTimes(2);
      });

      it("skips ownership seeding when the org has no owner membership set", async () => {
        const { db, mocks } = buildMockDb(null);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

        expect(mocks.txSelect).toHaveBeenCalledTimes(1);
        expect(mocks.onConflictDoNothing).not.toHaveBeenCalled();
        expect(mocks.insert).toHaveBeenCalledTimes(2);
      });

      it("uses onConflictDoNothing so re-enabling the same module is idempotent", async () => {
        const { db, mocks } = buildMockDb(42);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

        expect(mocks.onConflictDoNothing).toHaveBeenCalledTimes(2);
        expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(2);
      });

      it("assigns the MODULE_OWNER role to the org owner when the role is seeded", async () => {
        const { db, mocks } = buildMockDb(42, 777);
        const { cache } = buildMockCache();

        await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

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

        expect(mocks.onConflictDoNothing).toHaveBeenCalledTimes(1);
        expect(mocks.insert).toHaveBeenCalledTimes(3);
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
