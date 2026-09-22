import { resolveLineItems, type StoredLineTax } from "./invoice-line-tax";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { InvoicesPostingService } from "../invoices-posting.service";
import { InvoicesUpdateService } from "../invoices-update.service";
import type { UpdateInvoiceInput } from "../dto/invoice-write.schemas";

const stored: StoredLineTax[] = [
  { gstRate: "18.00", hsnSacCode: "998314", timesheetEntryId: 4211 },
  { gstRate: "18.00", hsnSacCode: null, timesheetEntryId: null },
];

describe("editing a draft invoice does not erase the timesheet entry its lines bill", () => {
  it("carries the stored link forward by position, the edit DTO having no field a client could resend it in", () => {
    const lines = resolveLineItems(
      [
        { description: "Consulting", quantity: 1, rate: 1000, amount: 1000, gstRate: 18 },
        { description: "Licence", quantity: 1, rate: 500, amount: 500, gstRate: 18 },
      ],
      stored,
    );

    expect(lines.map((line) => line.timesheetEntryId)).toEqual([4211, null]);
  });

  it("carries nothing onto an appended line, which bills no stored time", () => {
    const lines = resolveLineItems(
      [
        { description: "Consulting", quantity: 1, rate: 1000, amount: 1000, gstRate: 18 },
        { description: "Licence", quantity: 1, rate: 500, amount: 500, gstRate: 18 },
        { description: "Expenses", quantity: 1, rate: 250, amount: 250, gstRate: 18 },
      ],
      stored,
    );

    expect(lines[2]?.timesheetEntryId).toBeNull();
  });

  it("drops the link when a line was removed, because request position is no longer storage position", () => {
    const lines = resolveLineItems(
      [{ description: "Consulting", quantity: 1, rate: 1000, amount: 1000, gstRate: 18 }],
      stored,
    );

    expect(lines[0]?.timesheetEntryId).toBeNull();
  });
});

describe("InvoicesUpdateService replaces a draft's lines without losing their timesheet links", () => {
  const ORG = "org-edit-1";
  const USER = "user-edit-1";
  const INVOICE_ID = 9;

  function makeDb(insertedRows: Array<Array<Record<string, unknown>>>) {
    const selectedColumns: Array<Record<string, unknown>> = [];
    const values = jest.fn((rows: Array<Record<string, unknown>>) => {
      insertedRows.push(rows);
      return Promise.resolve(undefined);
    });
    const tx = {
      select: jest.fn((columns: Record<string, unknown>) => {
        selectedColumns.push(columns);
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue(stored),
            }),
          }),
        };
      }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      insert: jest.fn().mockReturnValue({ values }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    const db = {
      query: {
        invoices: {
          findFirst: jest.fn().mockResolvedValue({
            id: INVOICE_ID,
            orgId: ORG,
            status: "DRAFT",
            invoiceNumber: "INV-009",
            subtotal: "1500",
            discount: "0",
            taxRate: "0",
            total: "1770",
            placeOfSupply: null,
            currency: "INR",
          }),
        },
        organizations: { findFirst: jest.fn().mockResolvedValue({ address: null }) },
      },
      transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      update: jest.fn(),
    } as unknown as Db;
    return { db, selectedColumns };
  }

  function makeService(db: Db): InvoicesUpdateService {
    const posting: Partial<InvoicesPostingService> = {};
    const audit: Partial<AuditService> = { log: jest.fn() };
    return new InvoicesUpdateService(db, posting as InvoicesPostingService, audit as AuditService);
  }

  const editInput: UpdateInvoiceInput = {
    lineItems: [
      { description: "Consulting", quantity: 1, rate: 1000, amount: 1000, gstRate: 18 },
      { description: "Licence", quantity: 1, rate: 500, amount: 500, gstRate: 18 },
    ],
  } as UpdateInvoiceInput;

  it("re-inserts the link the delete-all-then-reinsert edit would otherwise erase", async () => {
    const insertedRows: Array<Array<Record<string, unknown>>> = [];
    const { db } = makeDb(insertedRows);

    await makeService(db).updateInvoice(ORG, USER, INVOICE_ID, editInput);

    expect(insertedRows[0]?.map((row) => row.timesheetEntryId)).toEqual([4211, null]);
  });

  it("reads the stored link back before deleting, there being nowhere else to recover it from", async () => {
    const insertedRows: Array<Array<Record<string, unknown>>> = [];
    const { db, selectedColumns } = makeDb(insertedRows);

    await makeService(db).updateInvoice(ORG, USER, INVOICE_ID, editInput);

    expect(Object.keys(selectedColumns[0] ?? {})).toContain("timesheetEntryId");
  });
});
