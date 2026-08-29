import type { ReorderProposalService } from "./forecast/reorder-proposal.service";
import type { AccessService } from "../../access/access.service";
import { InvReplenishmentService } from "./inv-replenishment.service";

const mockDb = {
  query: {
    invReorderRules: { findMany: jest.fn(), findFirst: jest.fn() },
  },
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  offset: jest.fn().mockReturnThis(),
  then: jest.fn(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn(),
  transaction: jest.fn(),
};

const mockCache = {
  cached: jest.fn((_, fn) => fn()),
  cachedVersioned: jest.fn((_namespace, _hash, fn) => fn()),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
  invalidatePattern: jest.fn(),
};

const mockNumSeq = { next: jest.fn() };

// These two arrived when the replenishment screen was wired to the forecast
// engine. Nothing in this file's suggestion-math tests reaches them, so they
// exist to satisfy the constructor rather than to be asserted on -- but they
// are typed against the real services rather than invented, because a mock
// whose method names are fiction fails with "is not a function" the first time
// somebody writes a test that does reach it, and says nothing about why.
const mockReorderProposals: jest.Mocked<Pick<ReorderProposalService, "propose">> = {
  propose: jest.fn(),
};
const mockAccess: jest.Mocked<Pick<AccessService, "resolveUserPermissions">> = {
  resolveUserPermissions: jest.fn(),
};

function buildService() {
  return new InvReplenishmentService(
    mockDb as never,
    mockCache as never,
    mockNumSeq as never,
    mockReorderProposals as never,
    mockAccess as never,
  );
}

const DEFAULT_FILTERS = { page: 1, limit: 50 };

describe("InvReplenishmentService - suggestion math", () => {
  beforeEach(() => jest.clearAllMocks());

  it("suggests maxQty - forecasted when rule has maxQty", async () => {
    const rule = {
      id: 1,
      productVariantId: 10,
      warehouseId: null,
      minQty: "15",
      maxQty: "50",
      reorderQty: null,
      leadTimeDays: 7,
      vendorId: null,
      isActive: true,
      productVariant: { sku: "SKU-001", name: "Var A", product: { id: 1, name: "Prod A", sku: "SKU-001", defaultVendorId: null } },
      warehouse: null,
    };
    mockDb.query.invReorderRules.findMany.mockResolvedValue([rule]);

    const stockRows = [{ variantId: 10, onHand: "10", onOrder: "0", outgoing: "0" }];
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({ groupBy: () => Promise.resolve(stockRows) }),
      }),
    });

    const service = buildService();
    const result = await service.getSuggestions("org1", DEFAULT_FILTERS);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].suggestedQty).toBe(40);
  });

  it("suggests reorderQty when no maxQty is set", async () => {
    const rule = {
      id: 2,
      productVariantId: 20,
      warehouseId: null,
      minQty: "5",
      maxQty: null,
      reorderQty: "25",
      leadTimeDays: 3,
      vendorId: 5,
      isActive: true,
      productVariant: { sku: "SKU-002", name: "Var B", product: { id: 2, name: "Prod B", sku: "SKU-002", defaultVendorId: null } },
      warehouse: null,
    };
    mockDb.query.invReorderRules.findMany.mockResolvedValue([rule]);

    const stockRows = [{ variantId: 20, onHand: "3", onOrder: "0", outgoing: "0" }];
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({ groupBy: () => Promise.resolve(stockRows) }),
      }),
    });

    const service = buildService();
    const result = await service.getSuggestions("org1", DEFAULT_FILTERS);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].suggestedQty).toBe(25);
    expect(result.items[0].vendorId).toBe(5);
  });

  it("falls back to minQty - forecasted when no maxQty or reorderQty", async () => {
    const rule = {
      id: 3,
      productVariantId: 30,
      warehouseId: null,
      minQty: "10",
      maxQty: null,
      reorderQty: null,
      leadTimeDays: 5,
      vendorId: null,
      isActive: true,
      productVariant: { sku: "SKU-003", name: "Var C", product: { id: 3, name: "Prod C", sku: "SKU-003", defaultVendorId: 99 } },
      warehouse: null,
    };
    mockDb.query.invReorderRules.findMany.mockResolvedValue([rule]);

    const stockRows = [{ variantId: 30, onHand: "2", onOrder: "1", outgoing: "0" }];
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({ groupBy: () => Promise.resolve(stockRows) }),
      }),
    });

    const service = buildService();
    const result = await service.getSuggestions("org1", DEFAULT_FILTERS);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].suggestedQty).toBe(7);
    expect(result.items[0].vendorId).toBe(99);
  });

  it("does not suggest when forecasted >= minQty", async () => {
    const rule = {
      id: 4,
      productVariantId: 40,
      warehouseId: null,
      minQty: "5",
      maxQty: "50",
      reorderQty: null,
      leadTimeDays: 7,
      vendorId: null,
      isActive: true,
      productVariant: { sku: "SKU-004", name: "Var D", product: { id: 4, name: "Prod D", sku: "SKU-004", defaultVendorId: null } },
      warehouse: null,
    };
    mockDb.query.invReorderRules.findMany.mockResolvedValue([rule]);

    const stockRows = [{ variantId: 40, onHand: "20", onOrder: "5", outgoing: "2" }];
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({ groupBy: () => Promise.resolve(stockRows) }),
      }),
    });

    const service = buildService();
    const result = await service.getSuggestions("org1", DEFAULT_FILTERS);

    expect(result.items).toHaveLength(0);
  });
});
