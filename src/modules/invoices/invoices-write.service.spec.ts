import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getTableConfig } from "drizzle-orm/pg-core";
import { invoiceItems } from "../../db/schema";
import { InvoicesWriteService } from "./invoices-write.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { InvoicesPostingService } from "./invoices-posting.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { InvoicesUpdateService } from "./invoices-update.service";
import { InvoicesPaymentService } from "./invoices-payment.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { createInvoiceSchema, type CreateInvoiceInput } from "./dto/invoice-write.schemas";

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

interface StoredTimesheetRow {
  id: number;
  status: string;
  voidedAt: Date | null;
  invoicingStatus?: string;
}

interface SelectChain {
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
}

describe("InvoicesWriteService — cache invalidation", () => {
  let service: InvoicesWriteService;
  let mockCache: { invalidateNamespace: jest.Mock; invalidateNamespaceForOrg: jest.Mock; invalidate: jest.Mock };
  let mockUpdateService: { updateInvoice: jest.Mock };
  let mockLifecycle: { voidInvoice: jest.Mock; markOverdueInvoices: jest.Mock };
  let timesheetRows: StoredTimesheetRow[];
  let dbSelect: jest.Mock;
  let txInsert: jest.Mock;
  let txValues: jest.Mock;

  const insertedItemRows = (): Array<Record<string, unknown>> =>
    (txValues.mock.calls[1]?.[0] ?? []) as Array<Record<string, unknown>>;

  beforeEach(async () => {
    timesheetRows = [];
    txValues = jest.fn().mockReturnThis();
    txInsert = jest.fn().mockReturnValue({
        values: txValues,
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
    });

    const txChain = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ count: 0 }]),
      }),
      insert: txInsert,
    };

    const selectChain: SelectChain = {
      from: jest.fn(() => selectChain),
      where: jest.fn(() => selectChain),
      limit: jest.fn(() => Promise.resolve(timesheetRows)),
      then: (resolve, reject) => Promise.resolve(timesheetRows).then(resolve, reject),
    };
    dbSelect = jest.fn(() => selectChain);

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
      select: dbSelect,
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

  describe("createInvoice — the timesheet entry an invoice line bills", () => {
    const linkedInput = (...entryIds: Array<number | undefined>) =>
      makeCreateInput({
        items: entryIds.map((timesheetEntryId, index) => ({
          description: `Consulting ${index}`,
          quantity: 1,
          rate: 1000,
          gstRate: 0,
          timesheetEntryId,
        })),
      });

    it("admits the link on the create body, which the item schema silently stripped before it was declared", () => {
      const parsed = createInvoiceSchema.parse({
        items: [{ description: "Consulting", quantity: 1, rate: 1000, gstRate: 0, timesheetEntryId: 77 }],
      });

      expect(parsed.items?.[0]).toMatchObject({ timesheetEntryId: 77 });
    });

    it("refuses a non-positive entry id on the body rather than letting it reach the resolver", () => {
      const parsed = createInvoiceSchema.safeParse({
        items: [{ description: "Consulting", quantity: 1, rate: 1000, gstRate: 0, timesheetEntryId: 0 }],
      });

      expect(parsed.success).toBe(false);
    });

    it("persists the link when the entry is approved and belongs to the invoicing organization", async () => {
      timesheetRows = [{ id: 77, status: "APPROVED", voidedAt: null, invoicingStatus: "UNINVOICED" }];

      await service.createInvoice(ORG, USER, linkedInput(77));

      expect(insertedItemRows()[0]).toMatchObject({ timesheetEntryId: 77 });
    });

    it("writes null, and asks the database nothing, when no line cites a timesheet entry", async () => {
      await service.createInvoice(ORG, USER, makeCreateInput());

      expect(insertedItemRows()[0]).toMatchObject({ timesheetEntryId: null });
      expect(dbSelect).not.toHaveBeenCalled();
    });

    it("refuses an entry that resolves in another organization, which the NOT VALID foreign key would not catch", async () => {
      timesheetRows = [];

      await expect(service.createInvoice(ORG, USER, linkedInput(4242))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(txInsert).not.toHaveBeenCalled();
    });

    it("refuses a voided entry, voiding being the only deletion a timesheet has", async () => {
      timesheetRows = [{ id: 77, status: "APPROVED", voidedAt: new Date("2026-09-01T00:00:00Z") }];

      await expect(service.createInvoice(ORG, USER, linkedInput(77))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(txInsert).not.toHaveBeenCalled();
    });

    it("refuses an entry that is not APPROVED, the state every billing read in the timesheets module already requires", async () => {
      timesheetRows = [{ id: 77, status: "PENDING", voidedAt: null }];

      await expect(service.createInvoice(ORG, USER, linkedInput(77))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("accepts an entry already flipped to INVOICE_DRAFTED, since that is where createInvoiceDraft leaves every entry it selects", async () => {
      timesheetRows = [{ id: 77, status: "APPROVED", voidedAt: null, invoicingStatus: "INVOICE_DRAFTED" }];

      await service.createInvoice(ORG, USER, linkedInput(77));

      expect(insertedItemRows()[0]).toMatchObject({ timesheetEntryId: 77 });
    });

    it("resolves every cited entry in one query rather than one per line", async () => {
      timesheetRows = [
        { id: 77, status: "APPROVED", voidedAt: null },
        { id: 78, status: "APPROVED", voidedAt: null },
      ];

      await service.createInvoice(ORG, USER, linkedInput(77, 78, undefined));

      expect(dbSelect).toHaveBeenCalledTimes(1);
      expect(insertedItemRows().map((row) => row.timesheetEntryId)).toEqual([77, 78, null]);
    });
  });

  describe("invoice_items declares the timesheet link but not its foreign key", () => {
    it("declares timesheet_entry_id as a nullable integer, without which drizzle can neither write nor read it", () => {
      const column = getTableConfig(invoiceItems).columns.find(
        (candidate) => candidate.name === "timesheet_entry_id",
      );

      expect(column).toBeDefined();
      expect(column?.notNull).toBe(false);
      expect(column?.hasDefault).toBe(false);
    });

    it("declares no foreign key on the link, because the live constraint is composite on org_id and this table deliberately leaves org_id to trg_set_org_id", () => {
      const config = getTableConfig(invoiceItems);

      const referencingColumns = config.foreignKeys.flatMap((key) =>
        key.reference().columns.map((column) => column.name),
      );

      expect(config.columns.some((candidate) => candidate.name === "org_id")).toBe(false);
      expect(referencingColumns).not.toContain("timesheet_entry_id");
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
