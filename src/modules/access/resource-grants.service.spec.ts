import { NotFoundException } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ResourceGrantsService, type GrantResourceInput } from "./resource-grants.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function buildMockDb() {
  const returning = jest.fn();
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });

  const deleteWhere = jest.fn().mockResolvedValue([]);
  const deleteFrom = jest.fn().mockReturnValue({ where: deleteWhere });

  const findMany = jest.fn();
  const findFirst = jest.fn();

  const db: DeepPartial<Db> = {
    query: {
      resourceGrants: { findMany, findFirst },
    } as unknown as Db["query"],
    insert,
    delete: deleteFrom,
  };

  return { db: db as unknown as Db, mocks: { findMany, findFirst, insert, values, onConflictDoNothing, returning, deleteFrom, deleteWhere } };
}

function makeUserCtx(partial: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    branchId: null,
    role: "ENGINEERING",
    permissions: [],
    enabledModules: [],
    plan: null,
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "session-1",
    ...partial,
  };
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
    it("delegates to db.query.resourceGrants.findMany and returns its result", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      const expected = [{ id: "grant-1" }];
      mocks.findMany.mockResolvedValue(expected);

      const result = await svc.listGrants("org-1", "kb_space", "space-1");

      expect(mocks.findMany).toHaveBeenCalledTimes(1);
      expect(result).toBe(expected);
    });

    it("returns an empty array when no grants exist", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.findMany.mockResolvedValue([]);

      const result = await svc.listGrants("org-1", "kb_space", "space-1");

      expect(result).toEqual([]);
    });
  });

  describe("grant", () => {
    it("inserts a new grant and returns the created record", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      const createdRecord = { id: "grant-1", orgId: "org-1" };
      mocks.returning.mockResolvedValue([createdRecord]);

      const result = await svc.grant("org-1", makeGrant(), "admin-1");

      expect(mocks.insert).toHaveBeenCalledTimes(1);
      expect(mocks.values).toHaveBeenCalledTimes(1);
      expect(mocks.onConflictDoNothing).toHaveBeenCalledTimes(1);
      expect(mocks.returning).toHaveBeenCalledTimes(1);
      expect(result).toBe(createdRecord);
    });

    it("returns null when the insert hits a conflict (no rows returned)", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.returning.mockResolvedValue([]);

      const result = await svc.grant("org-1", makeGrant(), "admin-1");

      expect(result).toBeNull();
    });

    it("passes the correct values to the insert chain", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.returning.mockResolvedValue([{ id: "grant-1" }]);

      const input = makeGrant({ principalType: "role", principalId: "role-99", permissionKey: "kb:space:edit" });
      await svc.grant("org-2", input, "granter-1");

      expect(mocks.values).toHaveBeenCalledWith(
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
  });

  describe("revoke", () => {
    it("throws NotFoundException when the grant does not exist", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.findFirst.mockResolvedValue(undefined);

      await expect(svc.revoke("org-1", "grant-999", makeUserCtx())).rejects.toBeInstanceOf(NotFoundException);
    });

    it("deletes the grant and returns { success: true } when it exists", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.findFirst.mockResolvedValue({ id: "grant-1", orgId: "org-1" });

      const result = await svc.revoke("org-1", "grant-1", makeUserCtx());

      expect(mocks.deleteFrom).toHaveBeenCalledTimes(1);
      expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true });
    });

    it("does not delete when findFirst returns no result", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.findFirst.mockResolvedValue(null);

      await expect(svc.revoke("org-1", "grant-404", makeUserCtx())).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.deleteFrom).not.toHaveBeenCalled();
    });
  });

  describe("hasGrant", () => {
    it("returns true when a matching grant exists", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.findFirst.mockResolvedValue({ id: "grant-1" });

      const result = await svc.hasGrant("org-1", "user-1", "kb_space", "space-1", "kb:space:view");

      expect(result).toBe(true);
    });

    it("returns false when no matching grant exists", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.findFirst.mockResolvedValue(undefined);

      const result = await svc.hasGrant("org-1", "user-1", "kb_space", "space-1", "kb:space:view");

      expect(result).toBe(false);
    });

    it("returns false when findFirst returns null", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.findFirst.mockResolvedValue(null);

      const result = await svc.hasGrant("org-1", "user-1", "kb_space", "space-1", "kb:space:edit");

      expect(result).toBe(false);
    });

    it("calls findFirst once with any args for a single hasGrant check", async () => {
      const { db, mocks } = buildMockDb();
      const svc = new ResourceGrantsService(db);
      mocks.findFirst.mockResolvedValue(null);

      await svc.hasGrant("org-1", "user-42", "project", "proj-1", "project:view");

      expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    });
  });
});
