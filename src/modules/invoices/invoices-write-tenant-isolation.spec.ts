import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import type { CacheService } from "../../common/cache/cache.service";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { JournalPostingService } from "../accounting/posting/journal-posting.service";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import type { InvoicesPaymentService } from "./invoices-payment.service";
import type { InvoicesUpdateService } from "./invoices-update.service";
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
    const mockPosting = stubService<JournalPostingService>({ seedChartOfAccountsForOrg: jest.fn() });
    const mockLifecycle = stubService<InvoicesLifecycleService>({ voidInvoice: jest.fn().mockRejectedValue(new NotFoundException("Invoice not found")) });
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const mockPlanLimits = stubService<PlanLimitsService>({ assertWithinLimit: jest.fn() });
    const mockPaymentService = stubService<InvoicesPaymentService>({});
    const mockUpdateService = stubService<InvoicesUpdateService>({ updateInvoice: jest.fn().mockRejectedValue(new NotFoundException("Invoice not found")) });
    const mockCache = stubService<CacheService>({ invalidateNamespace: jest.fn(), invalidateNamespaceForOrg: jest.fn() });
    const svc = new InvoicesWriteService(db, mockPosting, mockLifecycle, mockAudit, mockPlanLimits, mockPaymentService, mockUpdateService, mockCache);
    await expect(svc.voidInvoice(ATTACKER, USER_ID, INVOICE_ID)).rejects.toThrow(NotFoundException);
  });

  it("succeeds for invoice in the owning org (control — same-tenant)", async () => {
    const db = makeDb();
    const mockPosting = stubService<JournalPostingService>({});
    const mockLifecycle = stubService<InvoicesLifecycleService>({ voidInvoice: jest.fn().mockResolvedValue({ success: true }) });
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const mockPlanLimits = stubService<PlanLimitsService>({ assertWithinLimit: jest.fn() });
    const mockPaymentService = stubService<InvoicesPaymentService>({});
    const mockUpdateService = stubService<InvoicesUpdateService>({});
    const mockCache = stubService<CacheService>({ invalidateNamespace: jest.fn(), invalidateNamespaceForOrg: jest.fn() });
    const svc = new InvoicesWriteService(db, mockPosting, mockLifecycle, mockAudit, mockPlanLimits, mockPaymentService, mockUpdateService, mockCache);
    const result = await svc.voidInvoice(OWNER, USER_ID, INVOICE_ID);
    expect(result).toEqual({ success: true });
  });
});
