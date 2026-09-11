import { ConflictException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { InvoicesUpdateService } from "./invoices-update.service";
import { canPatchInvoiceStatus } from "./lib/invoice-transitions";
import type { UpdateInvoiceInput } from "./dto/invoice-write.schemas";

const ORG = "org-1";
const USER = "user-1";
const INVOICE_ID = 7;

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
    const posting = { postInvoiceIssued: jest.fn() };
    const svc = new InvoicesUpdateService(db, posting as never, { log: jest.fn() } as never);

    await expect(
      svc.updateInvoice(ORG, USER, INVOICE_ID, { status: "ISSUED" } as UpdateInvoiceInput),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(transaction).not.toHaveBeenCalled();
    expect(posting.postInvoiceIssued).not.toHaveBeenCalled();
  });

  it("rejects marking a paid invoice back to issued", async () => {
    const { db, transaction } = makeUpdateDb("PAID");
    const posting = { postInvoiceIssued: jest.fn() };
    const svc = new InvoicesUpdateService(db, posting as never, { log: jest.fn() } as never);

    await expect(
      svc.updateInvoice(ORG, USER, INVOICE_ID, { status: "ISSUED" } as UpdateInvoiceInput),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("still posts the journal when a draft invoice is issued, inside the write transaction", async () => {
    const { db, transaction } = makeUpdateDb("DRAFT");
    const tx = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
    };
    (transaction as jest.Mock).mockImplementation(async (fn: (t: unknown) => Promise<void>) => fn(tx));
    const posting = { postInvoiceIssued: jest.fn().mockResolvedValue(null) };
    const svc = new InvoicesUpdateService(db, posting as never, { log: jest.fn() } as never);

    const result = await svc.updateInvoice(ORG, USER, INVOICE_ID, {
      status: "ISSUED",
    } as UpdateInvoiceInput);

    expect(result).toEqual({ success: true, posted: true });
    expect(posting.postInvoiceIssued).toHaveBeenCalledTimes(1);
    expect(posting.postInvoiceIssued).toHaveBeenCalledWith(
      ORG,
      USER,
      expect.objectContaining({ invoiceId: INVOICE_ID, invoiceNumber: "INV-1" }),
      tx,
    );
  });
});
