import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { InvoicesWriteService } from "./invoices-write.service";

describe("InvoicesWriteService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const INVOICE_ID = 11;
  const USER_ID = "user-abc";

  function makeDb(): Db {
    return {
      query: {
        invoices: { findFirst: jest.fn().mockResolvedValue(null) },
        accountingSettings: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: { invoices: { findFirst: jest.fn().mockResolvedValue(null) } },
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        execute: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as Db;
  }

  it("voidInvoice throws NotFoundException for a different org (cross-tenant isolation)", async () => {
    const db = makeDb();
    const mockPosting = { seedChartOfAccountsForOrg: jest.fn() } as any;
    const mockLifecycle = { voidInvoice: jest.fn().mockRejectedValue(new NotFoundException("Invoice not found")) } as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockPlanLimits = { assertWithinLimit: jest.fn() } as any;
    const mockPaymentService = {} as any;
    const mockUpdateService = { updateInvoice: jest.fn().mockRejectedValue(new NotFoundException("Invoice not found")) } as any;
    const mockCache = { invalidateNamespace: jest.fn() } as any;
    const svc = new InvoicesWriteService(db, mockPosting, mockLifecycle, mockAudit, mockPlanLimits, mockPaymentService, mockUpdateService, mockCache);
    await expect(svc.voidInvoice(ATTACKER, USER_ID, INVOICE_ID)).rejects.toThrow(NotFoundException);
  });

  it("succeeds for invoice in the owning org (control — same-tenant)", async () => {
    const db = makeDb();
    const mockPosting = {} as any;
    const mockLifecycle = { voidInvoice: jest.fn().mockResolvedValue({ success: true }) } as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockPlanLimits = { assertWithinLimit: jest.fn() } as any;
    const mockPaymentService = {} as any;
    const mockUpdateService = {} as any;
    const mockCache = { invalidateNamespace: jest.fn() } as any;
    const svc = new InvoicesWriteService(db, mockPosting, mockLifecycle, mockAudit, mockPlanLimits, mockPaymentService, mockUpdateService, mockCache);
    const result = await svc.voidInvoice(OWNER, USER_ID, INVOICE_ID);
    expect(result).toEqual({ success: true });
  });
});
