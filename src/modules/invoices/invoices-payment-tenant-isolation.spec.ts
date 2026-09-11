import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { InvoicesPostingService } from "./invoices-posting.service";
import { InvoicesPaymentService } from "./invoices-payment.service";

/**
 * The same-tenant control used to assert `.rejects.toThrow()` with no argument
 * while the collaborators were `{}`, so it passed on
 * `TypeError: this.posting.seedChartOfAccountsForOrg is not a function` — the
 * service crashed before it recorded anything, and a control named "proceeds
 * for invoice in the owning org" was asserting that it does not proceed.
 * Removing the org predicate from the in-transaction lock would not have moved
 * it. The doubles below carry the whole write path so the control reaches the
 * payment insert, and every org-scoped predicate the service issues is
 * captured and asserted.
 */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

type Rows = unknown[];

/**
 * A select chain that answers every builder method (`from`, `where`, `innerJoin`,
 * `for`, `limit`, `orderBy`, `groupBy`), records each `where` argument and
 * resolves to the rows queued for that call. A chain that answered only the
 * methods one call site happens to use is how the previous double let the
 * service die on a missing method.
 */
function makeSelect(queue: Rows[], whereArgs: unknown[]): jest.Mock {
  let call = 0;
  return jest.fn(() => {
    const rows = queue[call] ?? [];
    call += 1;
    const chain: Record<string, unknown> = {};
    const proxy: unknown = new Proxy(chain, {
      get(_t, prop) {
        if (prop === "then") return (resolve: (v: Rows) => unknown) => resolve(rows);
        return (...args: unknown[]) => {
          if (prop === "where") whereArgs.push(...args);
          return proxy;
        };
      },
    });
    return proxy;
  });
}

describe("InvoicesPaymentService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const INVOICE_ID = 5;
  const USER_ID = "user-abc";
  const PAYMENT_INPUT = {
    amount: 100,
    paymentDate: "2024-01-15",
    paymentMethod: "bank_transfer" as const,
  };

  function makeHarness(invoiceRow: unknown) {
    const whereArgs: unknown[] = [];
    const txWhereArgs: unknown[] = [];
    const insertValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 77, orgId: OWNER, invoiceId: INVOICE_ID }]),
    });
    const txUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    });
    const tx = {
      select: makeSelect(
        [
          [{ total: "500", status: "SENT" }],
          [{ totalPaid: "0" }],
        ],
        txWhereArgs,
      ),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      update: txUpdate,
    };
    const transaction = jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));

    const db = {
      query: {
        invoices: { findFirst: jest.fn().mockResolvedValue(invoiceRow) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: makeSelect([[{ totalPaid: "0" }], [{ userId: USER_ID }]], whereArgs),
      transaction,
    } as unknown as Db;

    const posting = stubService<InvoicesPostingService>({
      postPaymentReceipt: jest.fn().mockResolvedValue(null),
      postRealizedFx: jest.fn().mockResolvedValue(null),
    });
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
    const lifecycle = { recomputeInvoiceBalance: jest.fn().mockResolvedValue(undefined) };
    const audit = { log: jest.fn() };

    const svc = new InvoicesPaymentService(
      db,
      posting,
      dispatch as never,
      lifecycle as never,
      audit as never,
    );
    return { svc, db, tx, transaction, insertValues, posting, whereArgs, txWhereArgs };
  }

  it("throws NotFoundException when invoice belongs to a different org (cross-tenant isolation)", async () => {
    const { svc, transaction, insertValues } = makeHarness(null);

    await expect(
      svc.recordPayment(ATTACKER, USER_ID, INVOICE_ID, PAYMENT_INPUT),
    ).rejects.toThrow(NotFoundException);

    expect(transaction).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("proceeds for invoice in the owning org and records the payment (control — same-tenant)", async () => {
    const invoiceRow = {
      id: INVOICE_ID,
      orgId: OWNER,
      status: "SENT",
      total: "500",
      invoiceNumber: "INV-005",
      currency: "INR",
      exchangeRate: "1",
    };
    const { svc, transaction, insertValues, posting } = makeHarness(invoiceRow);

    const payment = await svc.recordPayment(OWNER, USER_ID, INVOICE_ID, PAYMENT_INPUT);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]?.[0]).toMatchObject({
      orgId: OWNER,
      invoiceId: INVOICE_ID,
      amount: "100.00",
      createdBy: USER_ID,
    });
    expect(posting.postPaymentReceipt).toHaveBeenCalledTimes(1);
    expect(payment).toMatchObject({ id: 77 });
  });

  it("binds every payment-path predicate to the caller's org, inside the transaction as well as outside", async () => {
    const invoiceRow = {
      id: INVOICE_ID,
      orgId: OWNER,
      status: "SENT",
      total: "500",
      invoiceNumber: "INV-005",
      currency: "INR",
      exchangeRate: "1",
    };
    const { svc, db, whereArgs, txWhereArgs } = makeHarness(invoiceRow);

    await svc.recordPayment(OWNER, USER_ID, INVOICE_ID, PAYMENT_INPUT);

    const lookup = (db.query.invoices.findFirst as jest.Mock).mock.calls[0]?.[0] as { where: unknown };
    expect(sqlValues(lookup.where)).toContain(OWNER);

    // Every predicate individually, not the flattened union: one org-unbound
    // predicate among org-bound siblings is invisible to a flattened check.
    // Reported as printable strings, not as the drizzle SQL objects themselves:
    // those are circular, and jest crashes serialising the failure diff.
    const unbound = (args: unknown[]) =>
      args
        .map((w, i) => ({ i, values: sqlValues(w) }))
        .filter((e) => !e.values.includes(OWNER))
        .map((e) => `predicate #${e.i} does not bind the org: ${JSON.stringify(e.values)}`);

    expect(txWhereArgs.length).toBeGreaterThan(0);
    expect(unbound(txWhereArgs)).toEqual([]);

    expect(whereArgs.length).toBeGreaterThan(0);
    expect(unbound(whereArgs)).toEqual([]);

    const allValues = [...txWhereArgs, ...whereArgs].flatMap((w) => sqlValues(w));
    expect(allValues).not.toContain(ATTACKER);
  });
});
