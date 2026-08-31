import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ManagedProductsService } from "./managed-products.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PmWorkspacesService } from "../pm-workspaces/pm-workspaces.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const ORG_ID = "org-1";
const OTHER_ORG = "org-9";
const USER_ID = "user-1";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    managedProductId: 1,
    orgId: ORG_ID,
    name: "Atlas",
    key: "ATLAS",
    description: null,
    ownerId: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe("ManagedProductsService", () => {
  let svc: ManagedProductsService;
  let mockDb: Record<string, unknown>;

  function makeSelectChain(rows: unknown[]) {
    const whereChain = { limit: jest.fn().mockResolvedValue(rows) };
    const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
    const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
    return { selectChain, fromChain, whereChain };
  }

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      query: {},
    };

    const module = await Test.createTestingModule({
      providers: [
        ManagedProductsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        {
          provide: PmWorkspacesService,
          useValue: { resolveDefaultWorkspaceId: jest.fn().mockResolvedValue("ws_default") },
        },
      ],
    }).compile();
    svc = module.get(ManagedProductsService);
  });

  describe("loadProduct — BOLA cross-tenant isolation", () => {
    it("throws 404 when the id belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getManagedProduct(OTHER_ORG, 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws 404 when the product is soft-deleted (deletedAt set)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getManagedProduct(ORG_ID, 999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns the row when it belongs to the caller's tenant", async () => {
      const product = makeProduct();
      const { selectChain } = makeSelectChain([product]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getManagedProduct(ORG_ID, 1)).resolves.toMatchObject({
        managedProductId: 1,
        orgId: ORG_ID,
      });
    });
  });

  describe("createManagedProduct — tenant-scoped uniqueness (23505 → 409)", () => {
    it("maps a Postgres unique violation to ConflictException", async () => {
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue({ code: "23505" }),
        }),
      });

      await expect(
        svc.createManagedProduct(ORG_ID, USER_ID, { name: "Atlas", key: "ATLAS" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("inserts and audit-logs on success", async () => {
      const row = makeProduct({ managedProductId: 7 });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([row]),
        }),
      });

      const result = await svc.createManagedProduct(ORG_ID, USER_ID, {
        name: "Atlas",
        key: "ATLAS",
      });

      expect(result).toMatchObject({ managedProductId: 7, orgId: ORG_ID });
      expect(mockAudit.log).toHaveBeenCalledTimes(1);
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "managed_product.created",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "managed_product",
        }),
      );
    });
  });

  describe("updateManagedProduct — re-asserts access before writing", () => {
    it("throws 404 (via loadProduct) when the id is not in the caller's tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updateManagedProduct(OTHER_ORG, USER_ID, 1, { name: "x" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("applies the patch and audit-logs when the product exists", async () => {
      const existing = makeProduct();
      const updated = makeProduct({ name: "Atlas v2" });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await svc.updateManagedProduct(ORG_ID, USER_ID, 1, {
        name: "Atlas v2",
      });

      expect(result).toMatchObject({ name: "Atlas v2" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "managed_product.updated", orgId: ORG_ID }),
      );
    });
  });

  describe("deleteManagedProduct — soft delete", () => {
    it("throws 404 when the id is not in the caller's tenant (no write)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.deleteManagedProduct(OTHER_ORG, USER_ID, 1),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("sets deletedAt and audit-logs when the product exists", async () => {
      const existing = makeProduct();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      await svc.deleteManagedProduct(ORG_ID, USER_ID, 1);

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
      );
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "managed_product.deleted", orgId: ORG_ID }),
      );
    });
  });

  describe("listManagedProducts — pagination envelope", () => {
    it("returns { data, pagination } with cursor-page shape", async () => {
      const rows = [makeProduct(), makeProduct({ managedProductId: 2, key: "B" })];

      (mockDb as { select: jest.Mock }).select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      });

      const result = await svc.listManagedProducts(ORG_ID, { limit: 20 } as never);

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({
        limit: 20,
        hasMore: false,
        nextCursor: null,
      });
    });
  });
});
