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
  invalidatePattern: jest.fn().mockResolvedValue(undefined),
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
  mockCache.invalidatePattern.mockResolvedValue(undefined);
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

/**
 * The discount ceiling, which was an empty `it.skip` with no reason given.
 *
 * It is the only thing standing between a rep and a margin they are not
 * entitled to give away: nothing else in the quote path looks at
 * `maxDiscountPercent`, and `approvalStatus` is what the lifecycle service then
 * refuses to send on. An empty placeholder named the rule and asserted none of
 * it, so the ceiling could have been deleted without a single test going red.
 */
describe("QuotesService — discount gating (create + update)", () => {
  let svc: QuotesService;

  /**
   * A transaction double that RUNS its callback — a bare jest.fn() here would
   * make every assertion below vacuous, since the whole insert happens inside
   * it — and reports the row it was asked to insert.
   */
  function captureCreate(): { values: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    const countChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([{ count: 0 }]),
    };
    const tx = {
      select: jest.fn(() => countChain),
      insert: jest.fn(() => ({
        values: jest.fn((rows: Record<string, unknown> | Record<string, unknown>[]) => {
          // The line-item insert passes an array; only the quote row matters.
          if (!Array.isArray(rows)) captured = rows;
          return {
            returning: jest.fn().mockResolvedValue([{ id: QUOTE_ID, quoteNumber: "QT-1" }]),
            then: (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve),
          };
        }),
      })),
    };
    mockDb.transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    return { values: () => captured };
  }

  function captureUpdate(): { set: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    const tx = {
      update: jest.fn(() => ({
        set: jest.fn((values: Record<string, unknown>) => {
          captured = values;
          return {
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([makeQuote()]),
            }),
          };
        }),
      })),
    };
    mockDb.transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    return { set: () => captured };
  }

  const LINE_ITEMS = [{ description: "Widget", quantity: 1, unitPrice: 1000, taxRate: 0 }];

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

  it("create: sets approvalStatus=pending when the discount exceeds the ceiling", async () => {
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({
      orgId: ORG,
      maxDiscountPercent: 10,
      defaultExpiryDays: 30,
    });
    const created = captureCreate();

    await svc.create(ORG, USER, {
      subject: "Deep discount",
      discountPercent: 25,
      lineItems: LINE_ITEMS,
    } as never);

    expect(created.values().approvalStatus).toBe("pending");
  });

  it("create: leaves approvalStatus unset at exactly the ceiling", async () => {
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({
      orgId: ORG,
      maxDiscountPercent: 10,
      defaultExpiryDays: 30,
    });
    const created = captureCreate();

    await svc.create(ORG, USER, {
      subject: "At the limit",
      discountPercent: 10,
      lineItems: LINE_ITEMS,
    } as never);

    // The ceiling is what a rep MAY give, not the first value they may not.
    // Off by one here sends every fully-authorised quote for approval.
    expect(created.values().approvalStatus).toBeUndefined();
  });

  it("create: does not require approval when the org has set no ceiling", async () => {
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({
      orgId: ORG,
      maxDiscountPercent: null,
      defaultExpiryDays: 30,
    });
    const created = captureCreate();

    await svc.create(ORG, USER, {
      subject: "No ceiling configured",
      discountPercent: 90,
      lineItems: LINE_ITEMS,
    } as never);

    // A null ceiling means the org has not made this decision. Treating it as
    // zero would put every discounted quote in an approval queue nobody set up
    // and that nobody has the permission to clear.
    expect(created.values().approvalStatus).toBeUndefined();
  });

  it("update: raises approval when a discount is raised past the ceiling", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue({ id: QUOTE_ID });
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({
      orgId: ORG,
      maxDiscountPercent: 15,
      defaultExpiryDays: 30,
    });
    const updated = captureUpdate();

    await svc.update(ORG, USER, QUOTE_ID, { discountPercent: 40 } as never);

    expect(updated.set().approvalStatus).toBe("pending");
  });

  it("update: leaves approval alone when the discount is within the ceiling", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue({ id: QUOTE_ID });
    mockDb.query.crmQuoteSettings.findFirst.mockResolvedValue({
      orgId: ORG,
      maxDiscountPercent: 15,
      defaultExpiryDays: 30,
    });
    const updated = captureUpdate();

    await svc.update(ORG, USER, QUOTE_ID, { discountPercent: 5 } as never);

    expect(updated.set()).not.toHaveProperty("approvalStatus");
  });

  it("update: does not read the ceiling when the discount is not being changed", async () => {
    mockDb.query.quotes.findFirst.mockResolvedValue({ id: QUOTE_ID });
    const updated = captureUpdate();

    await svc.update(ORG, USER, QUOTE_ID, { subject: "Renamed" } as never);

    expect(mockDb.query.crmQuoteSettings.findFirst).not.toHaveBeenCalled();
    expect(updated.set()).not.toHaveProperty("approvalStatus");
  });
});
