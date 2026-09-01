import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OfferFulfillmentService } from "./offer-fulfillment.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG_ID = "org-1";
const OTHER_ORG = "org-9";
const USER_ID = "user-1";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeComponent(overrides: Record<string, unknown> = {}) {
  return {
    offerFulfillmentComponentId: 1,
    orgId: ORG_ID,
    crmOfferId: 10,
    crmOfferOrgId: ORG_ID,
    invSkuId: 20,
    invSkuOrgId: ORG_ID,
    quantityPerUnit: "1",
    uom: null,
    status: "active",
    effectiveFrom: null,
    effectiveTo: null,
    notes: null,
    createdBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("OfferFulfillmentService", () => {
  let svc: OfferFulfillmentService;
  let mockDb: Record<string, unknown>;

  function mockSelectOnce(rows: unknown[]) {
    (mockDb as { select: jest.Mock }).select.mockReturnValueOnce({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      }),
    });
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
        OfferFulfillmentService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    svc = module.get(OfferFulfillmentService);
  });

  describe("loadComponent — BOLA cross-tenant isolation", () => {
    it("throws 404 when the id belongs to a different tenant", async () => {
      mockSelectOnce([]);
      await expect(svc.getComponent(OTHER_ORG, 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns the row when it belongs to the caller's tenant", async () => {
      mockSelectOnce([makeComponent()]);
      await expect(svc.getComponent(ORG_ID, 1)).resolves.toMatchObject({
        offerFulfillmentComponentId: 1,
        orgId: ORG_ID,
      });
    });
  });

  describe("createComponent — validates both sides exist (tenant-scoped)", () => {
    it("throws 404 when the CRM offer is not in the org", async () => {
      mockSelectOnce([]); // assertOfferExists → none
      mockSelectOnce([{ id: 20 }]); // assertSkuExists → found (runs concurrently)
      await expect(
        svc.createComponent(ORG_ID, USER_ID, { crmOfferId: 10, invSkuId: 20, quantityPerUnit: 1, status: "active" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("throws 404 when the Inventory SKU is not in the org", async () => {
      mockSelectOnce([{ id: 10 }]); // offer found
      mockSelectOnce([]); // sku missing
      await expect(
        svc.createComponent(ORG_ID, USER_ID, { crmOfferId: 10, invSkuId: 20, quantityPerUnit: 1, status: "active" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("maps a duplicate mapping unique violation to ConflictException", async () => {
      mockSelectOnce([{ id: 10 }]);
      mockSelectOnce([{ id: 20 }]);
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue({ code: "23505" }),
        }),
      });
      await expect(
        svc.createComponent(ORG_ID, USER_ID, { crmOfferId: 10, invSkuId: 20, quantityPerUnit: 1, status: "active" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("inserts (stamping both org ids) and audit-logs on success", async () => {
      mockSelectOnce([{ id: 10 }]);
      mockSelectOnce([{ id: 20 }]);
      const row = makeComponent({ offerFulfillmentComponentId: 7 });
      const valuesSpy = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([row]),
      });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({ values: valuesSpy });

      const result = await svc.createComponent(ORG_ID, USER_ID, {
        crmOfferId: 10,
        invSkuId: 20,
        quantityPerUnit: 2.5,
        status: "active",
      });

      expect(valuesSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ORG_ID,
          crmOfferOrgId: ORG_ID,
          invSkuOrgId: ORG_ID,
          quantityPerUnit: "2.5",
          createdBy: USER_ID,
        }),
      );
      expect(result).toMatchObject({ offerFulfillmentComponentId: 7 });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "offer_fulfillment.created", orgId: ORG_ID }),
      );
    });
  });

  describe("updateComponent — re-asserts access before writing", () => {
    it("throws 404 when the id is not in the caller's tenant (no write)", async () => {
      mockSelectOnce([]); // loadComponent
      await expect(
        svc.updateComponent(OTHER_ORG, USER_ID, 1, { status: "inactive" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("applies the patch and audit-logs when the mapping exists", async () => {
      mockSelectOnce([makeComponent()]); // loadComponent
      const updated = makeComponent({ status: "inactive" });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      });
      const result = await svc.updateComponent(ORG_ID, USER_ID, 1, { status: "inactive" });
      expect(result).toMatchObject({ status: "inactive" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "offer_fulfillment.updated", orgId: ORG_ID }),
      );
    });
  });

  describe("deleteComponent — hard delete after access check", () => {
    it("throws 404 when the id is not in the caller's tenant (no delete)", async () => {
      mockSelectOnce([]); // loadComponent
      await expect(svc.deleteComponent(OTHER_ORG, USER_ID, 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect((mockDb as { delete: jest.Mock }).delete).not.toHaveBeenCalled();
    });

    it("deletes and audit-logs when the mapping exists", async () => {
      mockSelectOnce([makeComponent()]); // loadComponent
      const whereSpy = jest.fn().mockResolvedValue(undefined);
      (mockDb as { delete: jest.Mock }).delete.mockReturnValue({ where: whereSpy });
      await expect(svc.deleteComponent(ORG_ID, USER_ID, 1)).resolves.toEqual({
        success: true,
      });
      expect(whereSpy).toHaveBeenCalled();
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "offer_fulfillment.deleted", orgId: ORG_ID }),
      );
    });
  });

  describe("listComponents — pagination envelope", () => {
    it("returns { data, pagination } with computed totalPages", async () => {
      const rows = [makeComponent(), makeComponent({ offerFulfillmentComponentId: 2 })];
      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                    limit: jest.fn().mockResolvedValue(rows),
                }),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ total: 2 }]),
          }),
        };
      });

      const result = await svc.listComponents(ORG_ID, { limit: 20 });
      expect(result.data).toHaveLength(2);
      expect(result.pagination.limit).toBe(20);
    });
  });
});
