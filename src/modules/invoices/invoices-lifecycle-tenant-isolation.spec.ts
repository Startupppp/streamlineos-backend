import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { InvoicesPostingService } from "./invoices-posting.service";
import type { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { TimesheetInvoicingService } from "../timesheets/core/timesheet-invoicing.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";

describe("InvoicesLifecycleService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const INVOICE_ID = 3;
  const USER_ID = "user-abc";

  /**
   * `voidInvoice` now runs its status update and its timesheet-entry release
   * inside one `db.transaction` (invoices-lifecycle.service.ts) — a bare
   * `jest.fn()` here would silently void every assertion inside it (BE-136),
   * so `transaction` invokes its callback against `txChain`, and `txChain`
   * answers both the `invoice_items` lookup (`select`) and the invoice
   * status write (`update`) the callback makes.
   */
  function makeDb(invoiceRow: unknown, linkedTimesheetEntryIds: number[] = []): Db {
    const findFirst = jest.fn().mockResolvedValue(invoiceRow);
    const where = jest.fn().mockResolvedValue([{ allocationCount: 0, paymentCount: 0 }]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });

    const txSelectWhere = jest.fn().mockResolvedValue(
      linkedTimesheetEntryIds.map((id) => ({ timesheetEntryId: id })),
    );
    const txSelectFrom = jest.fn().mockReturnValue({ where: txSelectWhere });
    const txSelect = jest.fn().mockReturnValue({ from: txSelectFrom });
    const txUpdateWhere = jest.fn().mockResolvedValue([]);
    const txUpdateSet = jest.fn().mockReturnValue({ where: txUpdateWhere });
    const txUpdate = jest.fn().mockReturnValue({ set: txUpdateSet });
    const txChain = { select: txSelect, update: txUpdate };

    return {
      query: {
        invoices: { findFirst },
        journalEntries: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select,
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txChain)),
    } as unknown as Db;
  }

  function makeTimesheetInvoicing(releasedIds: number[] = []) {
    return stubService<TimesheetInvoicingService>({
      releaseEntriesToUninvoiced: jest.fn().mockResolvedValue(releasedIds),
    });
  }

  it("throws NotFoundException when invoice belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockPosting = stubService<InvoicesPostingService>({ reverseInvoiceIssued: jest.fn().mockResolvedValue(null) });
    const mockDispatch = stubService<NotificationDispatchService>({ emit: jest.fn() });
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn() });
    const mockTimesheetInvoicing = makeTimesheetInvoicing();
    const svc = new InvoicesLifecycleService(db, mockPosting, mockDispatch, mockBus, mockTimesheetInvoicing);
    await expect(svc.voidInvoice(ATTACKER, USER_ID, INVOICE_ID)).rejects.toThrow(NotFoundException);
    // Nothing of the other org's ledger is touched once the invoice read misses.
    expect(mockPosting.reverseInvoiceIssued).not.toHaveBeenCalled();
    expect(mockTimesheetInvoicing.releaseEntriesToUninvoiced).not.toHaveBeenCalled();
  });

  it("voids an invoice for the owning org (control — same-tenant)", async () => {
    const invoiceRow = { id: INVOICE_ID, orgId: OWNER, status: "SENT", invoiceNumber: "INV-001" };
    const db = makeDb(invoiceRow);
    const mockPosting = stubService<InvoicesPostingService>({ reverseInvoiceIssued: jest.fn().mockResolvedValue(null) });
    const mockDispatch = stubService<NotificationDispatchService>({ emit: jest.fn() });
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn() });
    const mockTimesheetInvoicing = makeTimesheetInvoicing();
    const svc = new InvoicesLifecycleService(db, mockPosting, mockDispatch, mockBus, mockTimesheetInvoicing);
    const result = await svc.voidInvoice(OWNER, USER_ID, INVOICE_ID);
    expect(result).toEqual({ success: true, releasedTimesheetEntryIds: [] });
    // The reversal is booked against the owning org's own invoice, never another's.
    expect(mockPosting.reverseInvoiceIssued).toHaveBeenCalledWith(
      OWNER,
      USER_ID,
      INVOICE_ID,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });

  /**
   * The stranded-record regression: `createFromTimesheets` and a manually
   * linked `createInvoice` item both leave a billed timesheet entry claimed
   * (`INVOICE_DRAFTED`/`INVOICED`) with nothing to reverse it. Voiding the
   * invoice that claimed it must release it back to `UNINVOICED`, in the
   * owning org, from the ids `invoice_items.timesheet_entry_id` names —
   * never the id of the whole other org's data.
   */
  it("releases the timesheet entries this invoice billed, scoped to the owning org, so a stranded entry is un-stuck by voiding", async () => {
    const invoiceRow = { id: INVOICE_ID, orgId: OWNER, status: "ISSUED", invoiceNumber: "INV-002" };
    const db = makeDb(invoiceRow, [77, 78]);
    const mockPosting = stubService<InvoicesPostingService>({ reverseInvoiceIssued: jest.fn().mockResolvedValue(null) });
    const mockDispatch = stubService<NotificationDispatchService>({ emit: jest.fn() });
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn() });
    const mockTimesheetInvoicing = makeTimesheetInvoicing([77, 78]);
    const svc = new InvoicesLifecycleService(db, mockPosting, mockDispatch, mockBus, mockTimesheetInvoicing);

    const result = await svc.voidInvoice(OWNER, USER_ID, INVOICE_ID);

    expect(result).toEqual({ success: true, releasedTimesheetEntryIds: [77, 78] });
    expect(mockTimesheetInvoicing.releaseEntriesToUninvoiced).toHaveBeenCalledWith(
      expect.anything(),
      OWNER,
      [77, 78],
    );
  });

  it("releases nothing when the invoice cites no timesheet entry", async () => {
    const invoiceRow = { id: INVOICE_ID, orgId: OWNER, status: "ISSUED", invoiceNumber: "INV-003" };
    const db = makeDb(invoiceRow, []);
    const mockPosting = stubService<InvoicesPostingService>({ reverseInvoiceIssued: jest.fn().mockResolvedValue(null) });
    const mockDispatch = stubService<NotificationDispatchService>({ emit: jest.fn() });
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn() });
    const mockTimesheetInvoicing = makeTimesheetInvoicing([]);
    const svc = new InvoicesLifecycleService(db, mockPosting, mockDispatch, mockBus, mockTimesheetInvoicing);

    const result = await svc.voidInvoice(OWNER, USER_ID, INVOICE_ID);

    expect(result).toEqual({ success: true, releasedTimesheetEntryIds: [] });
    expect(mockTimesheetInvoicing.releaseEntriesToUninvoiced).toHaveBeenCalledWith(expect.anything(), OWNER, []);
  });
});
