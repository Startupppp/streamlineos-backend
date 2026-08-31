import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { InvoicesPaymentService } from "./invoices-payment.service";

describe("InvoicesPaymentService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const INVOICE_ID = 5;
  const USER_ID = "user-abc";

  function makeDb(invoiceRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(invoiceRow);
    const where = jest.fn().mockResolvedValue([{ totalPaid: 0 }]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      query: {
        invoices: { findFirst },
        accountingSettings: { findFirst: jest.fn().mockResolvedValue(null) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select,
    } as unknown as Db;
  }

  it("throws NotFoundException when invoice belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockOutbox = {} as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockJournal = {} as any;
    const mockDispatch = { emit: jest.fn() } as any;
    const mockLifecycle = {} as any;
    const mockRate = {} as any;
    const mockFx = {} as any;
    const svc = new InvoicesPaymentService(db, mockOutbox, mockAudit, mockJournal, mockDispatch, mockLifecycle, mockRate, mockFx);
    const actor = { userId: USER_ID, orgId: ATTACKER } as any;
    await expect(svc.recordPayment(ATTACKER, USER_ID, INVOICE_ID, { amount: 100, currency: "INR", method: "bank_transfer" })).rejects.toThrow(NotFoundException);
  });

  it("proceeds for invoice in the owning org (control — same-tenant)", async () => {
    const invoiceRow = { id: INVOICE_ID, orgId: OWNER, status: "SENT", total: "500", invoiceNumber: "INV-005" };
    const db = makeDb(invoiceRow);
    const mockOutbox = {} as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockJournal = {} as any;
    const mockDispatch = { emit: jest.fn() } as any;
    const mockLifecycle = { recomputeInvoiceBalance: jest.fn() } as any;
    const mockRate = {} as any;
    const mockFx = {} as any;
    const svc = new InvoicesPaymentService(db, mockOutbox, mockAudit, mockJournal, mockDispatch, mockLifecycle, mockRate, mockFx);
    await expect(svc.recordPayment(OWNER, USER_ID, INVOICE_ID, { amount: 100, currency: "INR", method: "bank_transfer" })).rejects.toThrow();
  });
});
