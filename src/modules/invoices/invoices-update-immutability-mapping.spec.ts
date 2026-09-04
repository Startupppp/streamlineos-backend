/**
 * `updateInvoice` reads the invoice, checks `status === "DRAFT"`, and only then opens the
 * transaction that rewrites the lines. Between those two steps another request can issue the same
 * invoice, and from that point the database triggers — `trg_invoice_immutability` on `invoices`,
 * `trg_invoice_item_immutability` on `invoice_items` — are the only thing left standing between the
 * edit and a rewritten issued invoice.
 *
 * They stop it by raising SQLSTATE 23514. Nothing in `src/modules/invoices/` mentioned 23514,
 * `check_violation` or `isCheckViolation`, so that reached `AllExceptionsFilter` as an unrecognised
 * throw and the client got a 500 — "the server is broken" for what is really "somebody issued this
 * invoice while you were editing it", and a message the UI could not show.
 *
 * The error shape below is the one measured in `common/db/postgres-error.ts`: Drizzle's
 * `DrizzleQueryError` carries no `code` of its own and its message is `Failed query: …`; the
 * `PostgresError` with the SQLSTATE and the trigger's text sits one `cause` link down.
 */
import { ConflictException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { JournalPostingService } from "../accounting/posting/journal-posting.service";
import { InvoicesUpdateService } from "./invoices-update.service";

const ORG = "org-1";
const USER = "user-1";
const INVOICE_ID = 42;

const TRIGGER_MESSAGE =
  "line items of a non-draft invoice are immutable (invoice 42, status ISSUED); issue a credit note for corrections";

/** What postgres-js hands back through Drizzle for a trigger's `RAISE … USING ERRCODE`. */
function triggerViolation(message: string): Error {
  const driver = Object.assign(new Error(message), {
    code: "23514",
    severity: "ERROR",
    table_name: "invoice_items",
  });
  return Object.assign(new Error("Failed query: delete from \"invoice_items\""), { cause: driver });
}

function makeDb(transactionOutcome: () => Promise<unknown>): Db {
  const draft = {
    id: INVOICE_ID,
    orgId: ORG,
    status: "DRAFT",
    invoiceNumber: "INV-0042",
    subtotal: "1000",
    discount: "0",
    taxRate: "0",
    total: "1180",
    placeOfSupply: null,
    cgstAmount: "90",
    sgstAmount: "90",
    igstAmount: "0",
  };
  const emptyQuery = {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
        orderBy: jest.fn().mockResolvedValue([]),
      }),
    }),
  };
  return {
    query: {
      invoices: { findFirst: jest.fn().mockResolvedValue(draft) },
      organizations: { findFirst: jest.fn().mockResolvedValue(null) },
      accountingSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue(emptyQuery),
    update: jest
      .fn()
      .mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(() => transactionOutcome()),
  } as unknown as Db;
}

function build(db: Db): InvoicesUpdateService {
  return new InvoicesUpdateService(
    db,
    stubService<JournalPostingService>({
      seedChartOfAccountsForOrg: jest.fn(),
      gstSplit: jest.fn().mockReturnValue({ cgst: 90, sgst: 90, igst: 0 }),
    }),
    stubService<AuditService>({ log: jest.fn() }),
  );
}

const EDIT = {
  lineItems: [{ description: "Onboarding workshop", quantity: 1, rate: 1000, amount: 1000 }],
  taxRate: 0,
  discount: 0,
  currency: "INR",
};

describe("InvoicesUpdateService — an immutability trigger is a conflict, not a 500", () => {
  it("maps the trigger's check_violation to a ConflictException", async () => {
    const service = build(makeDb(() => Promise.reject(triggerViolation(TRIGGER_MESSAGE))));

    await expect(service.updateInvoice(ORG, USER, INVOICE_ID, EDIT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("carries the trigger's own message through, so the caller is told what happened", async () => {
    const service = build(makeDb(() => Promise.reject(triggerViolation(TRIGGER_MESSAGE))));

    await expect(service.updateInvoice(ORG, USER, INVOICE_ID, EDIT)).rejects.toThrow(
      /line items of a non-draft invoice are immutable/i,
    );
  });

  it("reads the SQLSTATE from the driver error under Drizzle's wrapper, not from the wrapper", async () => {
    // The wrapper has no `code` at all. A mapping that read `err.code` would miss every real one.
    const wrapper = triggerViolation(TRIGGER_MESSAGE);
    expect(Reflect.get(wrapper, "code")).toBeUndefined();

    const service = build(makeDb(() => Promise.reject(wrapper)));
    await expect(service.updateInvoice(ORG, USER, INVOICE_ID, EDIT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("leaves every other database failure alone, so a real fault still surfaces as one", async () => {
    const other = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    });
    const service = build(makeDb(() => Promise.reject(other)));

    // Rethrown untouched: same object, so the deadlock's SQLSTATE is still there for the retry
    // layer above to read, and it is not disguised as a client-side conflict.
    await expect(service.updateInvoice(ORG, USER, INVOICE_ID, EDIT)).rejects.toBe(other);
    await expect(service.updateInvoice(ORG, USER, INVOICE_ID, EDIT)).rejects.not.toBeInstanceOf(
      ConflictException,
    );
  });

  it("does not interfere with an edit that succeeds", async () => {
    const service = build(makeDb(() => Promise.resolve(undefined)));

    await expect(service.updateInvoice(ORG, USER, INVOICE_ID, EDIT)).resolves.toEqual({
      success: true,
      posted: false,
    });
  });
});
