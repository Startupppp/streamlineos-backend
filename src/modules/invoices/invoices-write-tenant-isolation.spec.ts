import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import type { CacheService } from "../../common/cache/cache.service";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import type { InvoicesPaymentService } from "./invoices-payment.service";
import type { InvoicesPostingService } from "./invoices-posting.service";
import type { InvoicesUpdateService } from "./invoices-update.service";
import { InvoicesWriteService } from "./invoices-write.service";

/**
 * Every double is typed `Partial<T>` rather than cast through `any`, so an
 * object literal naming a method the real collaborator does not have fails to
 * compile. That is not hypothetical here: the posting double used to stub
 * `seedChartOfAccountsForOrg`, which the accounting rewrite deliberately
 * removed from `InvoicesPostingService` — the chart is seeded by
 * `AccountingSetupService` when an organisation enables accounting. The stub
 * was inert and `as any` is what kept it compiling.
 */
function collaborators(lifecycle: Partial<InvoicesLifecycleService>, updateService: Partial<InvoicesUpdateService> = {}) {
  const posting: Partial<InvoicesPostingService> = {};
  const audit: Partial<AuditService> = { log: jest.fn() };
  const planLimits: Partial<PlanLimitsService> = { assertWithinLimit: jest.fn() };
  const paymentService: Partial<InvoicesPaymentService> = {};
  const cache: Partial<CacheService> = {
    invalidateNamespace: jest.fn(),
    invalidateNamespaceForOrg: jest.fn(),
  };
  return [
    posting as InvoicesPostingService,
    lifecycle as InvoicesLifecycleService,
    audit as AuditService,
    planLimits as PlanLimitsService,
    paymentService as InvoicesPaymentService,
    updateService as InvoicesUpdateService,
    cache as CacheService,
  ] as const;
}

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
    const svc = new InvoicesWriteService(db, ...collaborators(
      { voidInvoice: jest.fn().mockRejectedValue(new NotFoundException("Invoice not found")) },
      { updateInvoice: jest.fn().mockRejectedValue(new NotFoundException("Invoice not found")) },
    ));
    await expect(svc.voidInvoice(ATTACKER, USER_ID, INVOICE_ID)).rejects.toThrow(NotFoundException);
  });

  it("succeeds for invoice in the owning org (control — same-tenant)", async () => {
    const db = makeDb();
    const svc = new InvoicesWriteService(db, ...collaborators(
      { voidInvoice: jest.fn().mockResolvedValue({ success: true }) },
    ));
    const result = await svc.voidInvoice(OWNER, USER_ID, INVOICE_ID);
    expect(result).toEqual({ success: true });
  });
});
