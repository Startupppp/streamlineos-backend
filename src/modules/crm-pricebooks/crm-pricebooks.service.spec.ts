import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CrmPricebooksService } from "./crm-pricebooks.service";

const makeSelectChain = () => {
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    offset: jest.fn().mockReturnThis(),
  };
  return chain;
};

const makeInsertChain = () => ({
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
  onConflictDoUpdate: jest.fn().mockReturnThis(),
});

const makeUpdateChain = () => ({
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
});

const mockDb = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  query: {
    crmPricebooks: { findFirst: jest.fn() },
    crmProducts: { findFirst: jest.fn() },
    crmQuoteSettings: { findFirst: jest.fn() },
    crmQuoteTemplates: { findFirst: jest.fn() },
  },
};

const ORG = "org-1";
const PB_ID = "pb-uuid-1";
const PRODUCT_ID = 101;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("CrmPricebooksService.resolvePrice", () => {
  let svc: CrmPricebooksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CrmPricebooksService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    svc = module.get(CrmPricebooksService);
  });

  it("returns pricebook tier price when explicit pricebookId provided and entry exists", async () => {
    const chain = makeSelectChain();
    chain.limit.mockResolvedValue([{ unitPriceCents: 5000, pricebookName: "Enterprise" }]);
    mockDb.select.mockReturnValue(chain);

    const result = await svc.resolvePrice(ORG, {
      productId: PRODUCT_ID,
      pricebookId: PB_ID,
      quantity: 3,
    });

    expect(result.unitPriceCents).toBe(5000);
    expect(result.source).toBe("pricebook");
    expect(result.pricebookName).toBe("Enterprise");
  });

  it("falls back to default pricebook when no pricebookId provided but default pricebook entry exists", async () => {
    const defaultPbEntry = [{ unitPriceCents: 3000 }];
    let selectCallCount = 0;
    mockDb.select.mockImplementation(() => {
      const chain = makeSelectChain();
      selectCallCount += 1;
      chain.limit.mockResolvedValue(selectCallCount === 1 ? defaultPbEntry : []);
      return chain;
    });
    mockDb.query.crmPricebooks.findFirst.mockResolvedValue({ id: "default-pb", name: "Default" });

    const result = await svc.resolvePrice(ORG, {
      productId: PRODUCT_ID,
      quantity: 1,
    });

    expect(result.unitPriceCents).toBe(3000);
    expect(result.source).toBe("pricebook");
    expect(result.pricebookName).toBe("Default");
  });

  it("falls back to product.unitPrice when no matching pricebook entry exists", async () => {
    const chain = makeSelectChain();
    chain.limit.mockResolvedValue([]);
    mockDb.select.mockReturnValue(chain);
    mockDb.query.crmPricebooks.findFirst.mockResolvedValue(null);
    mockDb.query.crmProducts.findFirst.mockResolvedValue({ unitPrice: 1200 });

    const result = await svc.resolvePrice(ORG, {
      productId: PRODUCT_ID,
      quantity: 1,
    });

    expect(result.unitPriceCents).toBe(1200);
    expect(result.source).toBe("product");
    expect(result.pricebookName).toBeNull();
  });

  it("throws NotFoundException when product not found and no pricebook entry", async () => {
    const chain = makeSelectChain();
    chain.limit.mockResolvedValue([]);
    mockDb.select.mockReturnValue(chain);
    mockDb.query.crmPricebooks.findFirst.mockResolvedValue(null);
    mockDb.query.crmProducts.findFirst.mockResolvedValue(null);

    await expect(
      svc.resolvePrice(ORG, { productId: PRODUCT_ID, quantity: 1 }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("CrmPricebooksService.upsertEntry", () => {
  let svc: CrmPricebooksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CrmPricebooksService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    svc = module.get(CrmPricebooksService);
  });

  it("returns upserted entry on success", async () => {
    const entry = { id: "entry-1", productId: PRODUCT_ID, unitPriceCents: 2500, minQuantity: 1 };
    mockDb.query.crmPricebooks.findFirst.mockResolvedValue({ id: PB_ID });
    const insertChain = makeInsertChain();
    insertChain.returning.mockResolvedValue([entry]);
    mockDb.insert.mockReturnValue(insertChain);

    const result = await svc.upsertEntry(ORG, PB_ID, {
      productId: PRODUCT_ID,
      unitPriceCents: 2500,
      minQuantity: 1,
    });

    expect(result).toEqual(entry);
  });

  it("converts DB 23505 error to ConflictException", async () => {
    mockDb.query.crmPricebooks.findFirst.mockResolvedValue({ id: PB_ID });
    const insertChain = makeInsertChain();
    insertChain.returning.mockRejectedValue({ code: "23505" });
    mockDb.insert.mockReturnValue(insertChain);

    await expect(
      svc.upsertEntry(ORG, PB_ID, { productId: PRODUCT_ID, unitPriceCents: 2500, minQuantity: 1 }),
    ).rejects.toThrow(ConflictException);
  });
});

describe("CrmPricebooksService.createPricebook", () => {
  let svc: CrmPricebooksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CrmPricebooksService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    svc = module.get(CrmPricebooksService);
  });

  it("clears isDefault on other pricebooks when isDefault=true", async () => {
    const createdPb = { id: "new-pb", name: "VIP", isDefault: true };
    const insertChain = makeInsertChain();
    insertChain.returning.mockResolvedValue([createdPb]);
    mockDb.insert.mockReturnValue(insertChain);

    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    await svc.createPricebook(ORG, {
      name: "VIP",
      currency: "USD",
      isDefault: true,
      isActive: true,
    });

    expect(mockDb.update).toHaveBeenCalled();
  });

  it("converts DB 23505 error to ConflictException", async () => {
    const insertChain = makeInsertChain();
    insertChain.returning.mockRejectedValue({ code: "23505" });
    mockDb.insert.mockReturnValue(insertChain);

    await expect(
      svc.createPricebook(ORG, { name: "Dup", currency: "USD", isDefault: false, isActive: true }),
    ).rejects.toThrow(ConflictException);
  });
});

describe("CrmPricebooksService.deletePricebook", () => {
  let svc: CrmPricebooksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CrmPricebooksService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    svc = module.get(CrmPricebooksService);
  });

  it("soft-deletes by setting deletedAt", async () => {
    mockDb.query.crmPricebooks.findFirst.mockResolvedValue({ id: PB_ID });
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    const result = await svc.deletePricebook(ORG, PB_ID);

    expect(mockDb.update).toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
    expect(result).toEqual({ success: true });
  });

  it("throws NotFoundException for non-existent pricebook", async () => {
    mockDb.query.crmPricebooks.findFirst.mockResolvedValue(null);

    await expect(svc.deletePricebook(ORG, "nonexistent")).rejects.toThrow(NotFoundException);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
