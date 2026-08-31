import { Test } from "@nestjs/testing";
import { InvoicesWriteService } from "./invoices-write.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { JournalPostingService } from "../accounting/posting/journal-posting.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { InvoicesUpdateService } from "./invoices-update.service";
import { InvoicesPaymentService } from "./invoices-payment.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { CreateInvoiceInput } from "./dto/invoice-write.schemas";

const ORG = "org-inv-1";
const USER = "user-inv-1";

function makeCreateInput(overrides: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return {
    clientId: undefined,
    projectId: undefined,
    items: [{ description: "Service", quantity: 1, rate: 1000, gstRate: 0 }],
    taxRate: 0,
    discount: 0,
    currency: "INR",
    status: "DRAFT",
    ...overrides,
  };
}

describe("InvoicesWriteService — cache invalidation", () => {
  let service: InvoicesWriteService;
  let mockCache: { invalidateNamespace: jest.Mock; invalidate: jest.Mock };
  let mockUpdateService: { updateInvoice: jest.Mock };
  let mockLifecycle: { voidInvoice: jest.Mock; markOverdueInvoices: jest.Mock };

  beforeEach(async () => {
    const txChain = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ count: 0 }]),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{
          id: 1,
          invoiceNumber: "INV-2026-0001",
          orgId: ORG,
          status: "DRAFT",
          subtotal: "1000.00",
          taxAmount: "0.00",
          discount: "0.00",
          total: "1000.00",
          currency: "INR",
          createdAt: new Date(),
          clientId: null,
          projectId: null,
          dueDate: null,
          notes: null,
          placeOfSupply: null,
          customerGstin: null,
          supplierGstin: null,
          reverseCharge: false,
          taxInclusive: false,
          taxRate: "0",
          cgstAmount: "0.0000",
          sgstAmount: "0.0000",
          igstAmount: "0.0000",
          sentAt: null,
          createdBy: USER,
        }]),
      }),
    };

    const mockDb = {
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txChain)),
      query: {
        invoices: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        organizations: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      }),
    };

    mockCache = {
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    mockUpdateService = { updateInvoice: jest.fn().mockResolvedValue({ success: true, posted: false }) };
    mockLifecycle = {
      voidInvoice: jest.fn().mockResolvedValue({ success: true }),
      markOverdueInvoices: jest.fn().mockResolvedValue({ updated: 0 }),
    };

    const mockPosting = {
      seedChartOfAccountsForOrg: jest.fn().mockResolvedValue(undefined),
      gstSplit: jest.fn().mockReturnValue({ cgst: 0, sgst: 0, igst: 0 }),
      postInvoiceSend: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        InvoicesWriteService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: JournalPostingService, useValue: mockPosting },
        { provide: InvoicesLifecycleService, useValue: mockLifecycle },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } },
        { provide: InvoicesPaymentService, useValue: { recordPayment: jest.fn() } },
        { provide: InvoicesUpdateService, useValue: mockUpdateService },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get(InvoicesWriteService);
  });

  describe("createInvoice", () => {
    it("bumps all four fin namespaces after the transaction commits", async () => {
      await service.createInvoice(ORG, USER, makeCreateInput());
      const keys = mockCache.invalidateNamespace.mock.calls.map((c: unknown[]) => c[0]);
      expect(keys).toContain(CACHE_KEYS.finReportsNamespace(ORG));
      expect(keys).toContain(CACHE_KEYS.finTaxDashboardNamespace(ORG));
      expect(keys).toContain(CACHE_KEYS.finTaxReportsNamespace(ORG));
      expect(keys).toContain(CACHE_KEYS.finForecastNamespace(ORG));
    });

    it("uses the same key functions the readers use (key construction parity)", async () => {
      await service.createInvoice(ORG, USER, makeCreateInput());
      const invalidatedKeys = mockCache.invalidateNamespace.mock.calls.map((c: unknown[]) => c[0]);
      expect(invalidatedKeys).toContain(`fin:reports:${ORG}`);
      expect(invalidatedKeys).toContain(`fin:tax-dashboard:${ORG}`);
      expect(invalidatedKeys).toContain(`fin:tax-reports:${ORG}`);
      expect(invalidatedKeys).toContain(`fin:forecast:${ORG}`);
    });
  });

  describe("updateInvoice", () => {
    it("bumps all four fin namespaces after the delegate commits", async () => {
      await service.updateInvoice(ORG, USER, 1, { status: "ISSUED" } as never);
      const keys = mockCache.invalidateNamespace.mock.calls.map((c: unknown[]) => c[0]);
      expect(keys).toContain(CACHE_KEYS.finReportsNamespace(ORG));
      expect(keys).toContain(CACHE_KEYS.finTaxDashboardNamespace(ORG));
      expect(keys).toContain(CACHE_KEYS.finTaxReportsNamespace(ORG));
      expect(keys).toContain(CACHE_KEYS.finForecastNamespace(ORG));
    });

    it("returns the delegate result unchanged", async () => {
      mockUpdateService.updateInvoice.mockResolvedValue({ success: true, posted: true });
      const result = await service.updateInvoice(ORG, USER, 1, { status: "ISSUED" } as never);
      expect(result).toEqual({ success: true, posted: true });
    });
  });

  describe("voidInvoice", () => {
    it("bumps all four fin namespaces after the delegate commits", async () => {
      await service.voidInvoice(ORG, USER, 1);
      const keys = mockCache.invalidateNamespace.mock.calls.map((c: unknown[]) => c[0]);
      expect(keys).toContain(CACHE_KEYS.finReportsNamespace(ORG));
      expect(keys).toContain(CACHE_KEYS.finTaxDashboardNamespace(ORG));
      expect(keys).toContain(CACHE_KEYS.finTaxReportsNamespace(ORG));
      expect(keys).toContain(CACHE_KEYS.finForecastNamespace(ORG));
    });

    it("returns the delegate result unchanged", async () => {
      const result = await service.voidInvoice(ORG, USER, 1);
      expect(result).toEqual({ success: true });
    });
  });
});
