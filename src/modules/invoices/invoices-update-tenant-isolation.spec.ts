import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { JournalPostingService } from "../accounting/posting/journal-posting.service";
import { InvoicesUpdateService } from "./invoices-update.service";

describe("InvoicesUpdateService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const INVOICE_ID = 8;
  const USER_ID = "user-abc";

  function makeDb(invoiceRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(invoiceRow);
    const updateChain = { set: jest.fn() };
    updateChain.set.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
    const update = jest.fn().mockReturnValue(updateChain);
    return {
      query: { invoices: { findFirst }, accountingSettings: { findFirst: jest.fn().mockResolvedValue(null) } },
      update,
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        update,
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        execute: jest.fn().mockResolvedValue([]),
      })),
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
  }

  it("throws NotFoundException when invoice belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockPosting = stubService<JournalPostingService>({ seedChartOfAccountsForOrg: jest.fn() });
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const svc = new InvoicesUpdateService(db, mockPosting, mockAudit);
    await expect(svc.updateInvoice(ATTACKER, USER_ID, INVOICE_ID, { notes: "updated" })).rejects.toThrow(NotFoundException);
  });

  it("updates invoice for the owning org (control — same-tenant)", async () => {
    const invoiceRow = { id: INVOICE_ID, orgId: OWNER, status: "DRAFT", invoiceNumber: "INV-008", subtotal: "200", discount: "0", cgstAmount: null, sgstAmount: null, igstAmount: null, total: "200" };
    const db = makeDb(invoiceRow);
    const mockPosting = stubService<JournalPostingService>({ seedChartOfAccountsForOrg: jest.fn() });
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const svc = new InvoicesUpdateService(db, mockPosting, mockAudit);
    const result = await svc.updateInvoice(OWNER, USER_ID, INVOICE_ID, { notes: "updated" });
    expect(result).toHaveProperty("success");
  });
});
