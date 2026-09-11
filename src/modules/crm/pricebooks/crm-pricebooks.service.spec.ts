jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(_db: unknown, fn: (tx: unknown) => Promise<T>) => fn(_db),
  runInNewTenantTransaction: <T>(_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(_db),
}));

import { DrizzleQueryError } from "drizzle-orm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
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

  /**
   * Replaces "converts DB 23505 error to ConflictException".
   *
   * That case rejected with a bare `{ code: "23505" }` and asserted a 409, and
   * it was wrong twice. Drizzle throws a `DrizzleQueryError` with the SQLSTATE
   * on `.cause`, so the handler it certified could never have fired against a
   * real database — the mock supplied the shape the broken code was looking
   * for. And the conflict it described cannot happen: `uniq_crm_pb_entry` is
   * this statement's own ON CONFLICT arbiter, so the one unique a caller can
   * collide is resolved into an update, and the only other unique on the table
   * is (org_id, id) over a generated uuid. The handler is deleted; what is
   * worth pinning is the arbiter that makes it unnecessary.
   */
  it("declares the entry uniqueness as its own conflict target, so a repeat re-prices", async () => {
    mockDb.query.crmPricebooks.findFirst.mockResolvedValue({ id: PB_ID });
    const insertChain = makeInsertChain();
    insertChain.returning.mockResolvedValue([
      { id: "entry-1", productId: PRODUCT_ID, unitPriceCents: 4000, minQuantity: 1 },
    ]);
    mockDb.insert.mockReturnValue(insertChain);

    await svc.upsertEntry(ORG, PB_ID, {
      productId: PRODUCT_ID,
      unitPriceCents: 4000,
      minQuantity: 1,
    });

    const config = insertChain.onConflictDoUpdate.mock.calls[0]?.[0] as
      | { target?: unknown[]; set?: Record<string, unknown> }
      | undefined;
    expect(config?.target).toHaveLength(4);
    expect(config?.set).toHaveProperty("unitPriceCents", 4000);
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

  /**
   * A real `DrizzleQueryError` wrapping a real postgres-js error, not a bare
   * `{ code: "23505" }`.
   *
   * The bare object is the shape that hid this bug for as long as it existed:
   * Drizzle throws a wrapper and keeps the SQLSTATE on `.cause`, so a service
   * reading `e.code` never fired against a real database — while a mock that
   * puts `code` on the top-level object passes either way. Rejecting with what
   * the driver and the ORM actually produce is what makes this able to fail.
   */
  it("converts a wrapped 23505 into a ConflictException naming the pricebook", async () => {
    const insertChain = makeInsertChain();
    insertChain.returning.mockRejectedValue(
      new DrizzleQueryError(
        "insert into crm_pricebooks ...",
        [],
        Object.assign(
          new Error(
            'duplicate key value violates unique constraint "uniq_crm_pricebooks_org_name"',
          ),
          { code: "23505", constraint_name: "uniq_crm_pricebooks_org_name" },
        ),
      ),
    );
    mockDb.insert.mockReturnValue(insertChain);

    await expect(
      svc.createPricebook(ORG, { name: "Dup", currency: "USD", isDefault: false, isActive: true }),
    ).rejects.toThrow(ConflictException);
    await expect(
      svc.createPricebook(ORG, { name: "Dup", currency: "USD", isDefault: false, isActive: true }),
    ).rejects.toThrow('A pricebook named "Dup" already exists');
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
