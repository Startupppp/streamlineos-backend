import { Test } from "@nestjs/testing";
import { InvoicesWriteService } from "./invoices-write.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { InvoicesPostingService } from "./invoices-posting.service";
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
  let mockCache: { invalidateNamespace: jest.Mock; invalidateNamespaceForOrg: jest.Mock; invalidate: jest.Mock };
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
        // createInvoice resolves the supplier's state code for the GST split.
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ address: null }),
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
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    mockUpdateService = { updateInvoice: jest.fn().mockResolvedValue({ success: true, posted: false }) };
    mockLifecycle = {
      voidInvoice: jest.fn().mockResolvedValue({ success: true }),
      markOverdueInvoices: jest.fn().mockResolvedValue({ updated: 0 }),
    };

    const mockPosting = {
      postInvoiceIssued: jest.fn().mockResolvedValue(null),
    };

    const module = await Test.createTestingModule({
      providers: [
        InvoicesWriteService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: InvoicesPostingService, useValue: mockPosting },
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
    it("bumps the invoices:list namespace after the transaction commits", async () => {
      await service.createInvoice(ORG, USER, makeCreateInput());
      expect(mockCache.invalidateNamespaceForOrg).toHaveBeenCalledWith(ORG, "invoices:list");
    });

    /**
     * These three cases asserted four `fin:*` bumps until 2026-09-12, and one of
     * them was named "key construction parity" with the readers. There were no
     * readers: `modules/finance/reports/` — every `cachedVersioned` call on
     * `fin:reports`, `fin:tax-dashboard`, `fin:tax-reports` and `fin:forecast` —
     * was absorbed by the accounting rewrite. The spec agreed with the defect
     * and would have failed the removal of four pointless Redis INCRs.
     *
     * So the assertion now runs the other way: nothing may bump a namespace with
     * no reader. Asserting the absence is what keeps a merge from reinstating
     * them, which is exactly how they arrived.
     */
    it("bumps no namespace whose readers the accounting rewrite removed", async () => {
      await service.createInvoice(ORG, USER, makeCreateInput());
      const keys = mockCache.invalidateNamespace.mock.calls.map((c: unknown[]) => c[0]);
      expect(keys).toHaveLength(0);
    });
  });

  describe("updateInvoice", () => {
    it("bumps invoices:list, and no reader-less namespace, after the delegate commits", async () => {
      await service.updateInvoice(ORG, USER, 1, { status: "ISSUED" } as never);
      expect(mockCache.invalidateNamespaceForOrg).toHaveBeenCalledWith(ORG, "invoices:list");
      expect(mockCache.invalidateNamespace.mock.calls).toHaveLength(0);
    });

    it("returns the delegate result unchanged", async () => {
      mockUpdateService.updateInvoice.mockResolvedValue({ success: true, posted: true });
      const result = await service.updateInvoice(ORG, USER, 1, { status: "ISSUED" } as never);
      expect(result).toEqual({ success: true, posted: true });
    });
  });

  describe("voidInvoice", () => {
    it("bumps invoices:list, and no reader-less namespace, after the delegate commits", async () => {
      await service.voidInvoice(ORG, USER, 1);
      expect(mockCache.invalidateNamespaceForOrg).toHaveBeenCalledWith(ORG, "invoices:list");
      expect(mockCache.invalidateNamespace.mock.calls).toHaveLength(0);
    });

    it("returns the delegate result unchanged", async () => {
      const result = await service.voidInvoice(ORG, USER, 1);
      expect(result).toEqual({ success: true });
    });
  });
});
