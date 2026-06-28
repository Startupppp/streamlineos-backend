import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ResourceGrantsService, type GrantResourceInput } from "./resource-grants.service";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function buildMockDb() {
  const returning = jest.fn();
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const txValues = jest.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
  const txInsert = jest.fn().mockReturnValue({ values: txValues });

  const txDeleteWhere = jest.fn().mockResolvedValue([]);
  const txDeleteFrom = jest.fn().mockReturnValue({ where: txDeleteWhere });

  const tx = { insert: txInsert, delete: txDeleteFrom };

  const transaction = jest.fn().mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));

  const countWhere = jest.fn().mockResolvedValue([{ value: 0 }]);
  const countFrom = jest.fn().mockReturnValue({ where: countWhere });
  const select = jest.fn().mockReturnValue({ from: countFrom });

  const findMany = jest.fn().mockResolvedValue([]);
  const findFirst = jest.fn();

  const db: DeepPartial<Db> = {
    query: {
      resourceGrants: { findMany, findFirst },
    } as unknown as Db["query"],
    select,
    transaction,
  };

  return {
    db: db as unknown as Db,
    mocks: { findMany, findFirst, select, countFrom, countWhere, transaction, tx, txInsert, txValues, onConflictDoNothing, returning, txDeleteFrom, txDeleteWhere },
  };
}

function buildMockCache() {
  const invalidatePattern = jest.fn().mockResolvedValue(undefined);
  const cache = { invalidatePattern } as unknown as CacheService;
  return { cache, mocks: { invalidatePattern } };
}

function makeGrant(overrides: Partial<GrantResourceInput> = {}): GrantResourceInput {
  return {
    resourceType: "kb_space",
    resourceId: "space-1",
    principalType: "user",
    principalId: "user-1",
    permissionKey: "kb:space:view",
    ...overrides,
  };
}

describe("ResourceGrantsService", () => {
  describe("listGrants", () => {
    it("returns paginated result with data, total, limit, and offset", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      const rows = [{ id: "grant-1" }];
      mocks.findMany.mockResolvedValue(rows);
      mocks.countWhere.mockResolvedValue([{ value: 1 }]);

      const result = await svc.listGrants("org-1", "kb_space", "space-1");

      expect(mocks.findMany).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ data: rows, total: 1, limit: 50, offset: 0 });
    });

    it("respects custom limit and offset", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findMany.mockResolvedValue([]);
      mocks.countWhere.mockResolvedValue([{ value: 0 }]);

      const result = await svc.listGrants("org-1", "kb_space", "space-1", { limit: 10, offset: 20 });

      expect(result.limit).toBe(10);
      expect(result.offset).toBe(20);
    });

    it("caps limit at 100", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findMany.mockResolvedValue([]);
      mocks.countWhere.mockResolvedValue([{ value: 0 }]);

      const result = await svc.listGrants("org-1", "kb_space", "space-1", { limit: 9999 });

      expect(result.limit).toBe(100);
    });

    it("returns empty data array when no grants exist", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findMany.mockResolvedValue([]);
      mocks.countWhere.mockResolvedValue([{ value: 0 }]);

      const result = await svc.listGrants("org-1", "kb_space", "space-1");

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe("grant", () => {
    it("throws ForbiddenException when callerManagesResource is false", async () => {
      const { db } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);

      await expect(svc.grant("org-1", makeGrant(), "admin-1", false)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("inserts a new grant and returns the created record", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      const createdRecord = { id: "grant-1", orgId: "org-1" };
      mocks.returning.mockResolvedValue([createdRecord]);

      const result = await svc.grant("org-1", makeGrant(), "admin-1", true);

      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.txInsert).toHaveBeenCalledTimes(2);
      expect(mocks.returning).toHaveBeenCalledTimes(1);
      expect(result).toBe(createdRecord);
    });

    it("returns null when the insert hits a conflict (no rows returned)", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.returning.mockResolvedValue([]);

      const result = await svc.grant("org-1", makeGrant(), "admin-1", true);

      expect(result).toBeNull();
    });

    it("passes the correct values to the insert chain", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.returning.mockResolvedValue([{ id: "grant-1" }]);

      const input = makeGrant({ principalType: "role", principalId: "role-99", permissionKey: "kb:space:edit" });
      await svc.grant("org-2", input, "granter-1", true);

      expect(mocks.txValues).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org-2",
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          principalType: "role",
          principalId: "role-99",
          permissionKey: "kb:space:edit",
          grantedBy: "granter-1",
        }),
      );
    });

    it("invalidates the user's permission cache after a successful user grant", async () => {
      const { db, mocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.returning.mockResolvedValue([{ id: "grant-1", orgId: "org-1" }]);

      await svc.grant("org-1", makeGrant({ principalType: "user", principalId: "user-42" }), "admin-1", true);

      expect(cacheMocks.invalidatePattern).toHaveBeenCalledWith("access:perms:org-1:user-42:*");
    });

    it("invalidates the entire org's permission cache after a role grant", async () => {
      const { db, mocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.returning.mockResolvedValue([{ id: "grant-1", orgId: "org-1" }]);

      await svc.grant("org-1", makeGrant({ principalType: "role", principalId: "role-7" }), "admin-1", true);

      expect(cacheMocks.invalidatePattern).toHaveBeenCalledWith("access:perms:org-1:*");
    });

    it("does not call invalidatePattern when the insert hits a conflict", async () => {
      const { db, mocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.returning.mockResolvedValue([]);

      await svc.grant("org-1", makeGrant(), "admin-1", true);

      expect(cacheMocks.invalidatePattern).not.toHaveBeenCalled();
    });
  });

  describe("revoke", () => {
    it("throws NotFoundException when the grant does not exist", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue(undefined);

      await expect(svc.revoke("org-1", "grant-999")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("deletes the grant and returns { success: true } when it exists", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue({ id: "grant-1", orgId: "org-1", principalType: "user", principalId: "user-1" });

      const result = await svc.revoke("org-1", "grant-1");

      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.txDeleteFrom).toHaveBeenCalledTimes(1);
      expect(mocks.txDeleteWhere).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true });
    });

    it("does not enter transaction when findFirst returns no result", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue(null);

      await expect(svc.revoke("org-1", "grant-404")).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("invalidates the user's permission cache after a successful user-principal revoke", async () => {
      const { db, mocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue({ id: "grant-1", orgId: "org-1", principalType: "user", principalId: "user-55" });

      await svc.revoke("org-1", "grant-1");

      expect(cacheMocks.invalidatePattern).toHaveBeenCalledWith("access:perms:org-1:user-55:*");
    });

    it("invalidates the entire org's permission cache after a role-principal revoke", async () => {
      const { db, mocks } = buildMockDb();
      const { cache, mocks: cacheMocks } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue({ id: "grant-1", orgId: "org-1", principalType: "role", principalId: "role-3" });

      await svc.revoke("org-1", "grant-1");

      expect(cacheMocks.invalidatePattern).toHaveBeenCalledWith("access:perms:org-1:*");
    });

    it("BOLA: cannot revoke a grant belonging to a different org (returns NotFoundException)", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue(null);

      await expect(svc.revoke("org-attacker", "grant-from-org-victim")).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.transaction).not.toHaveBeenCalled();
    });
  });

  describe("hasGrant", () => {
    it("returns true when a matching grant exists", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue({ id: "grant-1" });

      const result = await svc.hasGrant("org-1", "user-1", "kb_space", "space-1", "kb:space:view");

      expect(result).toBe(true);
    });

    it("returns false when no matching grant exists", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue(undefined);

      const result = await svc.hasGrant("org-1", "user-1", "kb_space", "space-1", "kb:space:view");

      expect(result).toBe(false);
    });

    it("returns false when findFirst returns null", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue(null);

      const result = await svc.hasGrant("org-1", "user-1", "kb_space", "space-1", "kb:space:edit");

      expect(result).toBe(false);
    });

    it("calls findFirst once with any args for a single hasGrant check", async () => {
      const { db, mocks } = buildMockDb();
      const { cache } = buildMockCache();
      const svc = new ResourceGrantsService(db, cache);
      mocks.findFirst.mockResolvedValue(null);

      await svc.hasGrant("org-1", "user-42", "project", "proj-1", "project:view");

      expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    });
  });
});
