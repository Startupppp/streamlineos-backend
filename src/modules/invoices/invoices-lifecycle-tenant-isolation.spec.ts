import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { InvoicesPostingService } from "./invoices-posting.service";
import type { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";

describe("InvoicesLifecycleService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const INVOICE_ID = 3;
  const USER_ID = "user-abc";

  function makeDb(invoiceRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(invoiceRow);
    const where = jest.fn().mockResolvedValue([{ allocationCount: 0, paymentCount: 0 }]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      query: {
        invoices: { findFirst },
        journalEntries: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select,
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    } as unknown as Db;
  }

  it("throws NotFoundException when invoice belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockPosting = stubService<InvoicesPostingService>({ reverseInvoiceIssued: jest.fn().mockResolvedValue(null) });
    const mockDispatch = stubService<NotificationDispatchService>({ emit: jest.fn() });
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn() });
    const svc = new InvoicesLifecycleService(db, mockPosting, mockDispatch, mockBus);
    await expect(svc.voidInvoice(ATTACKER, USER_ID, INVOICE_ID)).rejects.toThrow(NotFoundException);
    // Nothing of the other org's ledger is touched once the invoice read misses.
    expect(mockPosting.reverseInvoiceIssued).not.toHaveBeenCalled();
  });

  it("voids an invoice for the owning org (control — same-tenant)", async () => {
    const invoiceRow = { id: INVOICE_ID, orgId: OWNER, status: "SENT", invoiceNumber: "INV-001" };
    const db = makeDb(invoiceRow);
    const mockPosting = stubService<InvoicesPostingService>({ reverseInvoiceIssued: jest.fn().mockResolvedValue(null) });
    const mockDispatch = stubService<NotificationDispatchService>({ emit: jest.fn() });
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn() });
    const svc = new InvoicesLifecycleService(db, mockPosting, mockDispatch, mockBus);
    const result = await svc.voidInvoice(OWNER, USER_ID, INVOICE_ID);
    expect(result).toEqual({ success: true });
    // The reversal is booked against the owning org's own invoice, never another's.
    expect(mockPosting.reverseInvoiceIssued).toHaveBeenCalledWith(
      OWNER,
      USER_ID,
      INVOICE_ID,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });
});
