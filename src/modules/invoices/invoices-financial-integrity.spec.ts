import { ConflictException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { InvoicesUpdateService } from "./invoices-update.service";
import {
  INVOICE_SEND_SOURCE_EVENT,
  INVOICE_SOURCE_TYPE,
} from "../accounting/posting/journal-posting.data";
import { canPatchInvoiceStatus } from "./lib/invoice-transitions";
import type { UpdateInvoiceInput } from "./dto/invoice-write.schemas";

const ORG = "org-1";
const USER = "user-1";
const INVOICE_ID = 7;

interface JournalLookup {
  sourceType?: unknown;
  sourceEvent?: unknown;
}

function conditionValues(node: unknown, seen = new Set<object>()): unknown[] {
  if (node === null || typeof node !== "object") return [];
  if (seen.has(node as object)) return [];
  seen.add(node as object);
  const out: unknown[] = [];
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number") out.push(value);
    else out.push(...conditionValues(value, seen));
  }
  return out;
}

describe("voidInvoice reverses the journal entry that invoice posting actually wrote", () => {
  it("looks the entry up by the same (sourceType, sourceEvent) pair postInvoiceSend persists", () => {
    expect(INVOICE_SOURCE_TYPE).toBe("invoice");
    expect(INVOICE_SEND_SOURCE_EVENT).toBe("send");
  });

  it("reverses a POSTED invoice-send entry instead of silently finding nothing", async () => {
    const journalFindFirst = jest.fn().mockImplementation((args: { where: unknown }) => {
      const values = conditionValues(args.where);
      const lookup: JournalLookup = {
        sourceType: values.find((v) => v === INVOICE_SOURCE_TYPE),
        sourceEvent: values.find((v) => v === INVOICE_SEND_SOURCE_EVENT),
      };
      if (lookup.sourceType !== INVOICE_SOURCE_TYPE) return Promise.resolve(undefined);
      if (lookup.sourceEvent !== INVOICE_SEND_SOURCE_EVENT) return Promise.resolve(undefined);
      return Promise.resolve({ id: 555, status: "POSTED" });
    });

    const db = {
      query: {
        invoices: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: INVOICE_ID, orgId: ORG, status: "SENT", invoiceNumber: "INV-1" }),
        },
        journalEntries: { findFirst: journalFindFirst },
      },
      select: jest.fn().mockReturnValue({
        from: jest
          .fn()
          .mockReturnValue({ where: jest.fn().mockResolvedValue([{ allocationCount: 0, paymentCount: 0 }]) }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
    } as unknown as Db;

    const reverseJournal = jest.fn().mockResolvedValue({ reversalEntryId: 556 });
    const svc = new InvoicesLifecycleService(
      db,
      { reverseJournal } as never,
      { emit: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );

    await svc.voidInvoice(ORG, USER, INVOICE_ID);

    expect(reverseJournal).toHaveBeenCalledTimes(1);
    expect(reverseJournal.mock.calls[0]?.[1]).toBe(555);
  });
});

describe("invoice status patch transitions", () => {
  it("permits only the documented forward moves", () => {
    expect(canPatchInvoiceStatus("DRAFT", "ISSUED")).toBe(true);
    expect(canPatchInvoiceStatus("ISSUED", "PAID")).toBe(true);
    expect(canPatchInvoiceStatus("OVERDUE", "PAID")).toBe(true);
    expect(canPatchInvoiceStatus("PARTIALLY_PAID", "FAILED")).toBe(true);
  });

  it("refuses to reopen or re-issue terminal invoices", () => {
    expect(canPatchInvoiceStatus("PAID", "ISSUED")).toBe(false);
    expect(canPatchInvoiceStatus("VOIDED", "ISSUED")).toBe(false);
    expect(canPatchInvoiceStatus("VOIDED", "PAID")).toBe(false);
    expect(canPatchInvoiceStatus("DRAFT", "PAID")).toBe(false);
  });

  function makeUpdateDb(status: string) {
    const transaction = jest.fn();
    const db = {
      query: {
        invoices: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: INVOICE_ID, orgId: ORG, status, invoiceNumber: "INV-1" }),
        },
        organizations: { findFirst: jest.fn().mockResolvedValue({ address: null }) },
      },
      transaction,
    } as unknown as Db;
    return { db, transaction };
  }

  it("rejects re-issuing a voided invoice and never opens a write transaction", async () => {
    const { db, transaction } = makeUpdateDb("VOIDED");
    const posting = { seedChartOfAccountsForOrg: jest.fn(), postInvoiceSend: jest.fn() };
    const svc = new InvoicesUpdateService(db, posting as never, { log: jest.fn() } as never);

    await expect(
      svc.updateInvoice(ORG, USER, INVOICE_ID, { status: "ISSUED" } as UpdateInvoiceInput),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(transaction).not.toHaveBeenCalled();
    expect(posting.postInvoiceSend).not.toHaveBeenCalled();
  });

  it("rejects marking a paid invoice back to issued", async () => {
    const { db, transaction } = makeUpdateDb("PAID");
    const posting = { seedChartOfAccountsForOrg: jest.fn(), postInvoiceSend: jest.fn() };
    const svc = new InvoicesUpdateService(db, posting as never, { log: jest.fn() } as never);

    await expect(
      svc.updateInvoice(ORG, USER, INVOICE_ID, { status: "ISSUED" } as UpdateInvoiceInput),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("still posts the journal when a draft invoice is issued", async () => {
    const { db, transaction } = makeUpdateDb("DRAFT");
    const tx = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
    };
    (transaction as jest.Mock).mockImplementation(async (fn: (t: unknown) => Promise<void>) => fn(tx));
    const posting = {
      seedChartOfAccountsForOrg: jest.fn().mockResolvedValue(undefined),
      postInvoiceSend: jest.fn().mockResolvedValue({ id: 1, entryNumber: "JE-1" }),
    };
    const svc = new InvoicesUpdateService(db, posting as never, { log: jest.fn() } as never);

    const result = await svc.updateInvoice(ORG, USER, INVOICE_ID, {
      status: "ISSUED",
    } as UpdateInvoiceInput);

    expect(result).toEqual({ success: true, posted: true });
    expect(posting.postInvoiceSend).toHaveBeenCalledTimes(1);
  });
});
