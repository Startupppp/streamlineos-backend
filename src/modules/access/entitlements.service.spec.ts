import { BadRequestException } from "@nestjs/common";
import { EntitlementsService } from "./entitlements.service";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { PlanLimitsService } from "../billing/plan-limits.service";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function buildMockDb() {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = jest.fn().mockReturnValue({ values });
  const execute = jest.fn().mockResolvedValue({ rows: [] });
  const findFirst = jest.fn();
  const findMany = jest.fn().mockResolvedValue([]);
  const orgFindFirst = jest.fn();

  const txDb = { insert, execute };
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
    mocks: { findFirst, findMany, orgFindFirst, insert, values, onConflictDoUpdate, execute, transaction },
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

function buildService(db: Db, cache: CacheService) {
  const resolveTier = jest.fn().mockResolvedValue({ tier: "ENTERPRISE", plan: "ENTERPRISE" });
  const planLimits: DeepPartial<PlanLimitsService> = { resolveTier };
  return new EntitlementsService(db, cache, planLimits as unknown as PlanLimitsService);
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

    it("returns true for a CORE module key even with no rows (always-on)", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockResolvedValue([]);
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "kb");

      expect(result).toBe(true);
    });

    it("returns true on 42P01 error (graceful degradation — org_modules table missing)", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockRejectedValue({ code: "42P01" });
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(true);
    });

    it("returns true when the error message includes 'does not exist'", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findMany.mockRejectedValue(new Error("relation does not exist"));
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).isModuleEnabled("org-1", "hr");

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

      expect(mocks.insert).toHaveBeenCalledTimes(1);
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

    it("executes no raw SQL calls — org array sync was removed", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      expect(mocks.execute).not.toHaveBeenCalled();
    });

    it("executes no raw SQL calls when disabling a module", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await buildService(db, cache).setModuleEnabled("org-1", "hr", false, "user-1");

      expect(mocks.execute).not.toHaveBeenCalled();
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
  });

  describe("listModules", () => {
    it("returns all modules enabled when enabledModules is null (new org, array never set)", async () => {
      const { db, mocks } = buildMockDb();
      mocks.orgFindFirst.mockResolvedValue({ enabledModules: null });
      const { cache } = buildMockCache();

      const result = await buildService(db, cache).listModules("org-1");

      expect(result).toHaveLength(10);
      expect(result.every((r) => r.enabled)).toBe(true);
      expect(result.find((r) => r.moduleKey === "kb")).toMatchObject({ enabled: true, core: true });
      expect(result.find((r) => r.moduleKey === "blog")).toBeUndefined();
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

      expect(result).toHaveLength(10);
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

      expect(result).toHaveLength(10);
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
