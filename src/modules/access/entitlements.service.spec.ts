import { BadRequestException } from "@nestjs/common";
import { EntitlementsService } from "./entitlements.service";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function buildMockDb() {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = jest.fn().mockReturnValue({ values });
  const execute = jest.fn().mockResolvedValue({ rows: [] });
  const findFirst = jest.fn();
  const findMany = jest.fn();
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

describe("EntitlementsService", () => {
  describe("isModuleEnabled", () => {
    it("delegates to cache.cached with the correct cache key and ttl", async () => {
      const { db, mocks: dbMocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();
      dbMocks.findFirst.mockResolvedValue({ enabled: true });

      await new EntitlementsService(db, cache).isModuleEnabled("org-1", "hr");

      expect(cacheMocks.cached).toHaveBeenCalledWith(
        "entitlements:module:org-1:hr",
        expect.any(Function),
        30,
      );
    });

    it("returns true when no row found (no entitlement row defaults to allowed)", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findFirst.mockResolvedValue(undefined);
      const { cache } = buildMockCache();

      const result = await new EntitlementsService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(true);
    });

    it("returns true on 42P01 error (graceful degradation — org_modules table missing)", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findFirst.mockRejectedValue({ code: "42P01" });
      const { cache } = buildMockCache();

      const result = await new EntitlementsService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(true);
    });

    it("returns true when the error message includes 'does not exist'", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findFirst.mockRejectedValue(new Error("relation does not exist"));
      const { cache } = buildMockCache();

      const result = await new EntitlementsService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(true);
    });

    it("returns false when the row has enabled=false", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findFirst.mockResolvedValue({ enabled: false });
      const { cache } = buildMockCache();

      const result = await new EntitlementsService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(false);
    });

    it("returns true when the row has enabled=true", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findFirst.mockResolvedValue({ enabled: true });
      const { cache } = buildMockCache();

      const result = await new EntitlementsService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(true);
    });

    it("re-throws errors that are not missing-table errors", async () => {
      const { db, mocks } = buildMockDb();
      mocks.findFirst.mockRejectedValue(new Error("connection refused"));
      const { cache } = buildMockCache();

      await expect(
        new EntitlementsService(db, cache).isModuleEnabled("org-1", "hr"),
      ).rejects.toThrow("connection refused");
    });

    it("returns the cached value without querying the db on a cache hit", async () => {
      const { db, mocks: dbMocks } = buildMockDb();
      const { cache } = buildMockCache(async () => false);

      const result = await new EntitlementsService(db, cache).isModuleEnabled("org-1", "hr");

      expect(result).toBe(false);
      expect(dbMocks.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("setModuleEnabled", () => {
    it("wraps the upsert and org sync in a single transaction", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await new EntitlementsService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      expect(mocks.transaction).toHaveBeenCalledTimes(1);
    });

    it("upserts with enabled=true and the correct field values", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await new EntitlementsService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

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

      await new EntitlementsService(db, cache).setModuleEnabled("org-1", "hr", false, "user-1");

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

    it("executes exactly one raw SQL call when enabling a mapped module", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await new EntitlementsService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

      expect(mocks.execute).toHaveBeenCalledTimes(1);
    });

    it("executes exactly one raw SQL call when disabling a mapped module", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();

      await new EntitlementsService(db, cache).setModuleEnabled("org-1", "hr", false, "user-1");

      expect(mocks.execute).toHaveBeenCalledTimes(1);
    });

    it("throws 400 BadRequestException when toggling a core module (kb)", async () => {
      const { db } = buildMockDb();
      const { cache } = buildMockCache();

      await expect(
        new EntitlementsService(db, cache).setModuleEnabled("org-1", "kb", true, "user-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("skips the org array SQL for unmapped module keys (kb, blog, etc.)", async () => {
      const { db } = buildMockDb();
      const { cache } = buildMockCache();

      await expect(
        new EntitlementsService(db, cache).setModuleEnabled("org-1", "kb", true, "user-1"),
      ).rejects.toThrow("always-on");
    });

    it("invalidates the module, list, and session caches after the transaction", async () => {
      const { db } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();

      await new EntitlementsService(db, cache).setModuleEnabled("org-1", "hr", true, "user-1");

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

      const result = await new EntitlementsService(db, cache).listModules("org-1");

      expect(result).toHaveLength(10);
      expect(result.every((r) => r.enabled)).toBe(true);
      expect(result.find((r) => r.moduleKey === "kb")).toMatchObject({ enabled: true, core: true });
      expect(result.find((r) => r.moduleKey === "blog")).toMatchObject({ enabled: true, core: true });
    });

    it("derives enabled from the organizations.enabledModules array", async () => {
      const { db, mocks } = buildMockDb();
      mocks.orgFindFirst.mockResolvedValue({ enabledModules: ["HR", "PROJECTS"] });
      const { cache } = buildMockCache();

      const result = await new EntitlementsService(db, cache).listModules("org-1");

      expect(result).toHaveLength(10);
      expect(result.find((r) => r.moduleKey === "hr")?.enabled).toBe(true);
      expect(result.find((r) => r.moduleKey === "crm")?.enabled).toBe(false);
      expect(result.find((r) => r.moduleKey === "projects")?.enabled).toBe(true);
      expect(result.find((r) => r.moduleKey === "payroll")?.enabled).toBe(false);
      expect(result.find((r) => r.moduleKey === "kb")).toMatchObject({ enabled: true, core: true });
      expect(result.find((r) => r.moduleKey === "blog")).toMatchObject({ enabled: true, core: true });
    });

    it("marks kb and blog as core: true regardless of enabledModules", async () => {
      const { db, mocks } = buildMockDb();
      mocks.orgFindFirst.mockResolvedValue({ enabledModules: [] });
      const { cache } = buildMockCache();

      const result = await new EntitlementsService(db, cache).listModules("org-1");

      expect(result).toHaveLength(10);
      expect(result.find((r) => r.moduleKey === "kb")).toMatchObject({ enabled: true, core: true });
      expect(result.find((r) => r.moduleKey === "blog")).toMatchObject({ enabled: true, core: true });
      expect(result.find((r) => r.moduleKey === "hr")?.enabled).toBe(false);
    });

    it("re-throws non-missing-table errors from the org query", async () => {
      const { db, mocks } = buildMockDb();
      mocks.orgFindFirst.mockRejectedValue(new Error("query error"));
      const { cache } = buildMockCache();

      await expect(
        new EntitlementsService(db, cache).listModules("org-1"),
      ).rejects.toThrow("query error");
    });
  });
});
