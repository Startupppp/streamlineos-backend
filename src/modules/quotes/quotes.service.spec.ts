import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { QuotesService } from "./quotes.service";
import { QuotesLifecycleService } from "./quotes-lifecycle.service";

const mockBus = { emit: jest.fn().mockResolvedValue(undefined) };
const mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

const makeUpdateChain = () => ({
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
});

const makeSelectChain = () => ({
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  offset: jest.fn().mockResolvedValue([]),
});

const makeInsertChain = () => ({
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
  onConflictDoUpdate: jest.fn().mockReturnThis(),
});

const mockDb = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  transaction: jest.fn(),
  query: {
    quotes: { findFirst: jest.fn() },
    invoices: { findFirst: jest.fn() },
    crmQuoteSettings: { findFirst: jest.fn() },
  },
};

const mockCache = {
  cached: jest.fn(),
  cachedVersioned: jest.fn(),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
};

const mockAudit = { log: jest.fn() };

const ORG = "org-1";
const USER = "user-1";
const QUOTE_ID = 42;

const makeQuote = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: QUOTE_ID,
  orgId: ORG,
  quoteNumber: "QT-20260712-001",
  subject: "Test Quote",
  status: "DRAFT",
  approvalStatus: "none",
  clientId: "client-1",
  convertedInvoiceId: null,
  lineItems: [],
  currency: "USD",
  totalAmount: "1000.00",
  taxAmount: "0.00",
  netAmount: "1000.00",
  signedAt: null,
  signedDocumentRef: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCache.invalidateNamespace.mockResolvedValue(undefined);
  mockAudit.log.mockReturnValue(undefined);
  mockPlanLimits.assertWithinLimit.mockResolvedValue(undefined);
});

describe("QuotesService.convertToInvoice", () => {
  let svc: QuotesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotesService,
        QuotesLifecycleService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: AuditService, useValue: mockAudit },
        { provide: CrmAutomationBusService, useValue: mockBus },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
      ],
    }).compile();
    svc = module.get(QuotesService);
  });

  it("throws NotFoundException when quote not found", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(null);

    await expect(svc.convertToInvoice(ORG, USER, QUOTE_ID)).rejects.toThrow(NotFoundException);
  });

  it("throws ConflictException when convertedInvoiceId is not null (already converted)", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(
      makeQuote({ status: "ACCEPTED", convertedInvoiceId: "inv-existing" }),
    );

    await expect(svc.convertToInvoice(ORG, USER, QUOTE_ID)).rejects.toThrow(ConflictException);
  });

  it("throws BadRequestException when status is not ACCEPTED", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(makeQuote({ status: "DRAFT" }));

    await expect(svc.convertToInvoice(ORG, USER, QUOTE_ID)).rejects.toThrow(BadRequestException);
  });

  it("propagates ForbiddenException from plan limit and does not start a transaction", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(makeQuote({ status: "ACCEPTED" }));
    mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(
      new ForbiddenException("Invoice limit reached"),
    );

    await expect(svc.convertToInvoice(ORG, USER, QUOTE_ID)).rejects.toThrow(ForbiddenException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("succeeds for accepted quote — calls db.transaction and returns { invoice, quoteId }", async () => {
    const lineItems = [
      { description: "Widget", quantity: "2.00", unitPrice: "500.00", taxRate: "0.00", amount: "1000.00", displayOrder: 0 },
    ];
    mockDb.query.quotes.findFirst.mockResolvedValue(
      makeQuote({ status: "ACCEPTED", lineItems }),
    );

    const invoice = { id: "inv-new", invoiceNumber: "INV-20260712-001" };

    const txDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    };
    const selectChain = makeSelectChain();
    selectChain.from.mockReturnThis();
    selectChain.where.mockResolvedValue([{ count: 0 }]);
    txDb.select.mockReturnValue(selectChain);

    const invoiceInsertChain = makeInsertChain();
    invoiceInsertChain.returning.mockResolvedValue([invoice]);
    const lineItemsInsertChain = makeInsertChain();
    let insertCallCount = 0;
    txDb.insert.mockImplementation(() => {
      insertCallCount += 1;
      return insertCallCount === 1 ? invoiceInsertChain : lineItemsInsertChain;
    });

    const updateChain = makeUpdateChain();
    txDb.update.mockReturnValue(updateChain);

    mockDb.transaction.mockImplementation(
      async (cb: (tx: typeof txDb) => Promise<unknown>) => cb(txDb),
    );

    const result = await svc.convertToInvoice(ORG, USER, QUOTE_ID);

    expect(mockDb.transaction).toHaveBeenCalled();
    expect(result).toEqual({ invoice, quoteId: QUOTE_ID });
  });
});

describe("QuotesService.approve", () => {
  let svc: QuotesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotesService,
        QuotesLifecycleService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: AuditService, useValue: mockAudit },
        { provide: CrmAutomationBusService, useValue: mockBus },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
      ],
    }).compile();
    svc = module.get(QuotesService);
  });

  it("throws NotFoundException when quote not found", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(null);

    await expect(svc.approve(ORG, USER, QUOTE_ID)).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when approvalStatus is not pending", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(makeQuote({ approvalStatus: "approved" }));

    await expect(svc.approve(ORG, USER, QUOTE_ID)).rejects.toThrow(BadRequestException);
  });

  it("sets approvalStatus=approved, approvedById, and approvedAt on success", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(makeQuote({ approvalStatus: "pending" }));
    const approved = makeQuote({ approvalStatus: "approved", approvedById: USER });
    const updateChain = makeUpdateChain();
    updateChain.returning.mockResolvedValue([approved]);
    mockDb.update.mockReturnValue(updateChain);

    const result = await svc.approve(ORG, USER, QUOTE_ID);

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalStatus: "approved",
        approvedById: USER,
        approvedAt: expect.any(Date),
      }),
    );
    expect(result).toEqual(approved);
  });
});

describe("QuotesService.reject", () => {
  let svc: QuotesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotesService,
        QuotesLifecycleService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: AuditService, useValue: mockAudit },
        { provide: CrmAutomationBusService, useValue: mockBus },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
      ],
    }).compile();
    svc = module.get(QuotesService);
  });

  it("throws NotFoundException when quote not found", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(null);

    await expect(svc.reject(ORG, USER, QUOTE_ID)).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when approvalStatus is not pending", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(makeQuote({ approvalStatus: "none" }));

    await expect(svc.reject(ORG, USER, QUOTE_ID)).rejects.toThrow(BadRequestException);
  });

  it("sets approvalStatus=rejected and stores rejection reason on success", async () => {
    const reason = "Price too high";
    mockDb.query.quotes.findFirst.mockResolvedValue(makeQuote({ approvalStatus: "pending" }));
    const rejected = makeQuote({ approvalStatus: "rejected", rejectionReason: reason });
    const updateChain = makeUpdateChain();
    updateChain.returning.mockResolvedValue([rejected]);
    mockDb.update.mockReturnValue(updateChain);

    const result = await svc.reject(ORG, USER, QUOTE_ID, reason);

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalStatus: "rejected",
        rejectionReason: reason,
      }),
    );
    expect(result).toEqual(rejected);
  });
});

describe("QuotesService.send", () => {
  let svc: QuotesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotesService,
        QuotesLifecycleService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: AuditService, useValue: mockAudit },
        { provide: CrmAutomationBusService, useValue: mockBus },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
      ],
    }).compile();
    svc = module.get(QuotesService);
  });

  it("returns { error: 'not_draft' } when status is not DRAFT", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(makeQuote({ status: "SENT" }));

    const result = await svc.send(ORG, USER, QUOTE_ID);

    expect(result).toEqual({ error: "not_draft" });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("throws BadRequestException when clientId is null", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(makeQuote({ status: "DRAFT", clientId: null }));

    await expect(svc.send(ORG, USER, QUOTE_ID)).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when approvalStatus is pending", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(
      makeQuote({ status: "DRAFT", clientId: "client-1", approvalStatus: "pending" }),
    );

    await expect(svc.send(ORG, USER, QUOTE_ID)).rejects.toThrow(BadRequestException);
  });

  it("updates status to SENT and sets sentAt when draft with client and not pending approval", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue(
      makeQuote({ status: "DRAFT", clientId: "client-1", approvalStatus: "none" }),
    );
    const sent = makeQuote({ status: "SENT", sentAt: new Date() });
    const updateChain = makeUpdateChain();
    updateChain.returning.mockResolvedValue([sent]);
    mockDb.update.mockReturnValue(updateChain);

    const result = await svc.send(ORG, USER, QUOTE_ID);

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SENT", sentAt: expect.any(Date) }),
    );
    expect(result).toEqual(sent);
    expect(mockCache.invalidateNamespace).toHaveBeenCalledWith(`quotes:list:${ORG}`);
  });
});

describe("QuotesService — discount gating (create + update)", () => {
  let svc: QuotesService;

  const LINE_ITEMS = [{ description: "Widget", quantity: 2, unitPrice: 500 }];

  const makeCreateTx = () => {
    const countChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([{ count: 0 }]),
    };
    const quoteInsertChain = makeInsertChain();
    quoteInsertChain.returning.mockResolvedValue([makeQuote()]);
    const lineItemsInsertChain = makeInsertChain();
    let insertCallCount = 0;
    const txDb = {
      select: jest.fn().mockReturnValue(countChain),
      insert: jest.fn().mockImplementation(() => {
        insertCallCount += 1;
        return insertCallCount === 1 ? quoteInsertChain : lineItemsInsertChain;
      }),
      update: jest.fn(),
      delete: jest.fn(),
    };
    mockDb.transaction.mockImplementation(
      async (cb: (tx: typeof txDb) => Promise<unknown>) => cb(txDb),
    );
    return quoteInsertChain;
  };

  const makeUpdateTx = () => {
    const updateChain = makeUpdateChain();
    updateChain.returning.mockResolvedValue([makeQuote()]);
    const txDb = {
      select: jest.fn(),
      insert: jest.fn().mockReturnValue(makeInsertChain()),
      update: jest.fn().mockReturnValue(updateChain),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };
    mockDb.transaction.mockImplementation(
      async (cb: (tx: typeof txDb) => Promise<unknown>) => cb(txDb),
    );
    return updateChain;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotesService,
        QuotesLifecycleService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: AuditService, useValue: mockAudit },
        { provide: CrmAutomationBusService, useValue: mockBus },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
      ],
    }).compile();
    svc = module.get(QuotesService);
  });

  it("create: sets approvalStatus=pending when discount exceeds maxDiscountPercent setting", async () => {
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({ maxDiscountPercent: 10 });
    const quoteInsertChain = makeCreateTx();

    await svc.create(ORG, USER, {
      subject: "Discounted quote",
      lineItems: LINE_ITEMS,
      discountPercent: 25,
    });

    expect(quoteInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalStatus: "pending",
        totalAmount: "1000.00",
        discountAmount: "250.00",
        netAmount: "750.00",
      }),
    );
  });

  it("create: leaves approvalStatus unset when the discount is within maxDiscountPercent", async () => {
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({ maxDiscountPercent: 10 });
    const quoteInsertChain = makeCreateTx();

    await svc.create(ORG, USER, {
      subject: "Small discount",
      lineItems: LINE_ITEMS,
      discountPercent: 5,
    });

    const values = quoteInsertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values.approvalStatus).toBeUndefined();
    expect(values.discountAmount).toBe("50.00");
    expect(values.netAmount).toBe("950.00");
  });

  it("create: leaves approvalStatus unset when the org has configured no ceiling", async () => {
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({ maxDiscountPercent: null });
    const quoteInsertChain = makeCreateTx();

    await svc.create(ORG, USER, {
      subject: "No ceiling configured",
      lineItems: LINE_ITEMS,
      discountPercent: 90,
    });

    const values = quoteInsertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values.approvalStatus).toBeUndefined();
    expect(values.discountAmount).toBe("900.00");
  });

  it("create: a zero discount never needs approval, even against a zero ceiling", async () => {
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({ maxDiscountPercent: 0 });
    const quoteInsertChain = makeCreateTx();

    await svc.create(ORG, USER, { subject: "No discount", lineItems: LINE_ITEMS });

    const values = quoteInsertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values.approvalStatus).toBeUndefined();
    expect(values.discountAmount).toBe("0.00");
    expect(values.netAmount).toBe("1000.00");
  });

  it("update: sets approvalStatus=pending when the new discount exceeds maxDiscountPercent", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue({ id: QUOTE_ID });
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({ maxDiscountPercent: 10 });
    const updateChain = makeUpdateTx();

    await svc.update(ORG, USER, QUOTE_ID, { discountPercent: 25, lineItems: LINE_ITEMS });

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalStatus: "pending",
        discountAmount: "250.00",
        netAmount: "750.00",
      }),
    );
  });

  it("update: leaves approvalStatus untouched when the new discount is within the ceiling", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue({ id: QUOTE_ID });
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({ maxDiscountPercent: 10 });
    const updateChain = makeUpdateTx();

    await svc.update(ORG, USER, QUOTE_ID, { discountPercent: 5, lineItems: LINE_ITEMS });

    const patch = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("approvalStatus");
    expect(patch.netAmount).toBe("950.00");
  });

  it("update: leaves approvalStatus untouched when the org has configured no ceiling", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue({ id: QUOTE_ID });
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({ maxDiscountPercent: null });
    const updateChain = makeUpdateTx();

    await svc.update(ORG, USER, QUOTE_ID, { discountPercent: 90, lineItems: LINE_ITEMS });

    expect(updateChain.set.mock.calls[0][0]).not.toHaveProperty("approvalStatus");
  });

  it("update: does not read the discount ceiling when the payload carries no discount", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue({ id: QUOTE_ID });
    makeUpdateTx();

    await svc.update(ORG, USER, QUOTE_ID, { subject: "Renamed" });

    expect(mockDb.query.crmQuoteSettings.findFirst).not.toHaveBeenCalled();
  });
});
