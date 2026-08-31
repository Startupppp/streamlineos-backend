import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { RemindersService } from "./reminders.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";

const ORG_ID = "org-rem-1";

function buildQueryMock(firstRow: Record<string, unknown> | null) {
  return {
    finReminderPolicies: {
      findFirst: jest.fn().mockResolvedValue(firstRow),
    },
  };
}

function buildDbMockForUpdate(queryResult: Record<string, unknown> | null) {
  const returningFn = jest.fn().mockResolvedValue([queryResult ?? {}]);
  const whereFn = jest.fn().mockReturnValue({ returning: returningFn });
  const setFn = jest.fn().mockReturnValue({ where: whereFn });
  const updateFn = jest.fn().mockReturnValue({ set: setFn });

  return {
    update: updateFn,
    query: buildQueryMock(queryResult),
  };
}

function buildDbMockForDelete(queryResult: Record<string, unknown> | null) {
  const whereFn = jest.fn().mockResolvedValue(undefined);
  const setFn = jest.fn().mockReturnValue({ where: whereFn });
  const updateFn = jest.fn().mockReturnValue({ set: setFn });

  return {
    update: updateFn,
    query: buildQueryMock(queryResult),
  };
}

async function buildUpdateService(queryResult: Record<string, unknown> | null) {
  const db = buildDbMockForUpdate(queryResult);
  const audit = { log: jest.fn() } as unknown as AuditService;
  const module = await Test.createTestingModule({
    providers: [
      RemindersService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { svc: module.get(RemindersService), db, audit };
}

async function buildDeleteService(queryResult: Record<string, unknown> | null) {
  const db = buildDbMockForDelete(queryResult);
  const audit = { log: jest.fn() } as unknown as AuditService;
  const module = await Test.createTestingModule({
    providers: [
      RemindersService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { svc: module.get(RemindersService), db, audit };
}

describe("RemindersService", () => {
  describe("updatePolicy", () => {
    it("throws NotFoundException when the policy does not exist or is already archived", async () => {
      const { svc } = await buildUpdateService(null);
      await expect(svc.updatePolicy(ORG_ID, 1, { name: "New Name" })).rejects.toThrow(NotFoundException);
    });

    it("calls db.update when the policy exists and is not archived", async () => {
      const existing = { id: 1, orgId: ORG_ID, name: "Old", offsets: [1], channel: "EMAIL", isActive: true, archivedAt: null, createdAt: new Date(), updatedAt: new Date() };
      const { svc, db } = await buildUpdateService(existing);
      await svc.updatePolicy(ORG_ID, 1, { name: "New Name" });
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("does not proceed to db.update when policy is not found (query returns null)", async () => {
      const { svc, db } = await buildUpdateService(null);
      try {
        await svc.updatePolicy(ORG_ID, 99, { isActive: false });
      } catch {
        // expected NotFoundException
      }
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("deletePolicy", () => {
    it("throws NotFoundException when the policy does not exist", async () => {
      const { svc } = await buildDeleteService(null);
      await expect(svc.deletePolicy(ORG_ID, 99)).rejects.toThrow(NotFoundException);
    });

    it("soft-archives the policy by setting isActive: false when it exists", async () => {
      const existing = { id: 5, orgId: ORG_ID, name: "Policy", offsets: [], channel: "EMAIL", isActive: true, archivedAt: null };
      const { svc, db } = await buildDeleteService(existing);
      const result = await svc.deletePolicy(ORG_ID, 5);
      expect(result).toEqual({ success: true });
      const setArgs = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArgs?.set).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
    });
  });
});
