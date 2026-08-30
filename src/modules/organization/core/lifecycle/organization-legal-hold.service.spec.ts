import { Test } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { OrganizationLegalHoldService } from "./organization-legal-hold.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { OrganizationSagaService } from "./organization-saga.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

jest.mock("../../../../common/tenant/run-in-tenant-transaction");

const mockRunInTenantTransaction = jest.mocked(runInTenantTransaction);

function buildSelectChain(rows: unknown[]) {
  const resolved = Promise.resolve(rows);
  const chain: Record<string, unknown> = {
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  for (const m of ["from", "where", "orderBy"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.limit = jest.fn().mockResolvedValue(rows.slice(0, 1));
  return chain;
}

function buildUpdateChain(returnRows: unknown[] = [{ holdId: "hold-1" }]) {
  const returning = jest.fn().mockResolvedValue(returnRows);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  return { set };
}

async function buildService() {
  const auditLog = jest.fn();
  const sagaRunStep = jest
    .fn()
    .mockImplementation(
      (_sagaId: string, _step: string, fn: () => Promise<unknown>) => fn(),
    );
  const saga = {
    begin: jest
      .fn()
      .mockResolvedValue({ saga: { sagaId: "saga-123" }, steps: [] }),
    runStep: sagaRunStep,
    complete: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { log: auditLog };

  const moduleRef = await Test.createTestingModule({
    providers: [
      OrganizationLegalHoldService,
      { provide: DRIZZLE, useValue: {} },
      { provide: AuditService, useValue: audit },
      { provide: OrganizationSagaService, useValue: saga },
    ],
  }).compile();

  return {
    service: moduleRef.get(OrganizationLegalHoldService),
    audit,
    saga,
  };
}

describe("OrganizationLegalHoldService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("place", () => {
    it("succeeds and writes inside a tenant transaction when no active hold exists", async () => {
      const valuesInsert = jest.fn().mockResolvedValue(undefined);
      const tx = {
        select: jest
          .fn()
          .mockReturnValueOnce(buildSelectChain([{ statusV2: "ACTIVE" }]))
          .mockReturnValueOnce(buildSelectChain([])),
        insert: jest.fn().mockReturnValue({ values: valuesInsert }),
      };
      mockRunInTenantTransaction.mockImplementation((_db, fn) =>
        fn(tx as any),
      );

      const { service, audit } = await buildService();
      const result = await service.place("org-1", "user-1", "regulatory review");

      expect(result).toEqual({ success: true });
      expect(mockRunInTenantTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        expect.objectContaining({ orgId: "org-1" }),
      );
      expect(valuesInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org-1",
          reason: "regulatory review",
          placedBy: "user-1",
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "org.legal_hold_placed" }),
      );
    });

    it("throws ConflictException when an unreleased hold already exists", async () => {
      const tx = {
        select: jest
          .fn()
          .mockReturnValueOnce(buildSelectChain([{ statusV2: "ACTIVE" }]))
          .mockReturnValueOnce(buildSelectChain([{ holdId: "existing-hold" }])),
      };
      mockRunInTenantTransaction.mockImplementation((_db, fn) =>
        fn(tx as any),
      );

      const { service } = await buildService();
      await expect(
        service.place("org-1", "user-1", "reason"),
      ).rejects.toThrow(ConflictException);
    });

    it("throws BadRequestException when assertTransitionAllowed refuses the transition", async () => {
      const tx = {
        select: jest
          .fn()
          .mockReturnValueOnce(buildSelectChain([{ statusV2: "ARCHIVED" }]))
          .mockReturnValueOnce(buildSelectChain([])),
      };
      mockRunInTenantTransaction.mockImplementation((_db, fn) =>
        fn(tx as any),
      );

      const { service } = await buildService();
      await expect(
        service.place("org-1", "user-1", "reason"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("release", () => {
    it("throws NotFoundException via affected-row count when hold is already released", async () => {
      const tx = {
        select: jest
          .fn()
          .mockReturnValueOnce(buildSelectChain([{ statusV2: "ACTIVE" }])),
        update: jest.fn().mockReturnValue(buildUpdateChain([])),
      };
      mockRunInTenantTransaction.mockImplementation((_db, fn) =>
        fn(tx as any),
      );

      const { service } = await buildService();
      await expect(
        service.release("hold-1", "org-1", "user-1"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("listActive", () => {
    it("returns unreleased holds for the org", async () => {
      const holdRow = {
        holdId: "hold-1",
        orgId: "org-1",
        reason: "legal review",
        placedBy: "user-1",
        placedAt: new Date("2026-01-01"),
      };
      const tx = {
        select: jest.fn().mockReturnValue(buildSelectChain([holdRow])),
      };
      mockRunInTenantTransaction.mockImplementation((_db, fn) =>
        fn(tx as any),
      );

      const { service } = await buildService();
      const result = await service.listActive("org-1");

      expect(result).toEqual([holdRow]);
    });
  });
});
