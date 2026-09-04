/**
 * Real-database tests for two invariants of `POST /invoices/:id/payments`.
 *
 * 1. THE OVERPAYMENT GUARD IS EXACT. It summed the receipts as
 *    `COALESCE(sum(payments.amount::numeric), 0)::float` — an explicit double
 *    cast on money inside SQL — and then compared `input.amount > remaining +
 *    0.01`, so every invoice could be overpaid by a paisa, permanently, and the
 *    guard's own arithmetic was inexact besides.
 *
 * 2. ONE PAYMENT IS ONE QUANTITY. `payments.amount` is `numeric(12,2)` and
 *    `fin_payment_allocations.amount` is `numeric(18,4)`; the service wrote
 *    `.toFixed(2)` to one and `.toFixed(4)` to the other from the same input, so
 *    the payment register and the AR subledger recorded different money for the
 *    same receipt.
 *
 * Guarded by INV_DB_TESTS=1. Run with:
 *   INV_DB_TESTS=1 DATABASE_URL=... PGSSLMODE=disable \
 *     npx jest --runInBand --testPathPattern="invoice-payment-settled-amount.db"
 *
 * Only Postgres shows either one. The scale divergence exists only once the
 * column types are real — a mocked db stores whatever string it is handed at
 * whatever scale — and the guard's defect is in the SQL cast itself.
 *
 * Fixtures live under one throwaway org and are removed in afterAll via
 * ON DELETE CASCADE.
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { finPaymentAllocations, invoices, payments } from "../../../db/schema";
import { InvoicesPaymentService } from "../invoices-payment.service";
import { InvoicesLifecycleService } from "../invoices-lifecycle.service";
import { JournalPostingService } from "../../accounting/posting/journal-posting.service";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import { FinancePostingAccountsService } from "../../accounting/posting/finance-posting-accounts.service";
import { RateResolverService } from "../../finance/controls/rate-resolver.service";
import { FxService } from "../../finance/controls/fx.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CrmAutomationBusService } from "../../crm/automation-studio/crm-automation-bus.service";

const ENABLED = process.env.INV_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for INV_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const sslmode = url.searchParams.get("sslmode");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const ssl: "require" | false =
    sslmode === "disable" || process.env.PGSSLMODE === "disable" || local ? false : "require";
  return postgres(url.toString(), {
    prepare: false,
    max: 4,
    ssl,
    connect_timeout: 30,
    onnotice: () => {},
  });
}

const SUFFIX = randomUUID().slice(0, 8);
const ORG_ID = `inv-pay-${SUFFIX}`;
const USER_ID = `inv-pay-user-${SUFFIX}`;

describeDb("invoice payments record one exact quantity — real database", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let service: InvoicesPaymentService;
  let paymentDate: string;
  let invoiceSeq = 0;

  async function newInvoice(total: string): Promise<number> {
    invoiceSeq += 1;
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO invoices (org_id, invoice_number, status, subtotal, total, currency, created_by, due_date)
      VALUES (${ORG_ID}, ${`INV-${SUFFIX}-${invoiceSeq}`}, 'ISSUED', ${total}, ${total}, 'INR', ${USER_ID}, ${paymentDate})
      RETURNING id
    `;
    return row!.id;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    paymentDate = new Date().toISOString().slice(0, 10);

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, name, email)
        VALUES (${USER_ID}, 'Invoice Payment Fixture', ${`${USER_ID}@fixture.invalid`})
      `;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${ORG_ID}, ${`Invoice payment ${SUFFIX}`}, ${`invoice-payment-${SUFFIX}`}, 0)
      `;
      const [member] = await tx`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER_ID}, ${ORG_ID}, 'OWNER', true)
        RETURNING id
      `;
      await tx`
        UPDATE organizations SET owner_membership_id = ${member!.id} WHERE id = ${ORG_ID}
      `;
    });

    await sql`
      INSERT INTO accounting_settings (org_id, base_currency) VALUES (${ORG_ID}, 'INR')
    `;
    await sql`
      INSERT INTO accounting_periods (org_id, name, start_date, end_date, status)
      VALUES (${ORG_ID}, 'Fixture period', ${`${paymentDate.slice(0, 4)}-01-01`}, ${`${paymentDate.slice(0, 4)}-12-31`}, 'OPEN')
    `;

    const audit = { log: jest.fn() } as unknown as AuditService;
    const dispatch = {
      emit: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationDispatchService;
    const cache = {
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      cachedVersioned: (_ns: string, _key: string, fetcher: () => Promise<unknown>) => fetcher(),
    } as unknown as CacheService;
    const bus = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as CrmAutomationBusService;

    const journalPosting = new JournalPostingService(db);
    const financePosting = new FinancePostingService(
      db,
      new FinancePostingAccountsService(db),
      audit,
      dispatch,
      cache,
    );
    const lifecycle = new InvoicesLifecycleService(db, financePosting, dispatch, bus);

    service = new InvoicesPaymentService(
      db,
      journalPosting,
      dispatch,
      lifecycle,
      audit,
      new RateResolverService(db),
      new FxService(financePosting),
    );
  }, 90_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM organizations WHERE id = ${ORG_ID}`;
      await sql`DELETE FROM users WHERE id = ${USER_ID}`;
      await sql.end({ timeout: 5 });
    }
  });

  it("refuses the paisa of overpayment the tolerance used to allow", async () => {
    const invoiceId = await newInvoice("100.0000");

    await service.recordPayment(ORG_ID, USER_ID, invoiceId, {
      amount: 100,
      paymentDate,
      paymentMethod: "bank_transfer",
    });

    // `input.amount > remaining + 0.01` with remaining == 0 let this through.
    await expect(
      service.recordPayment(ORG_ID, USER_ID, invoiceId, {
        amount: 0.01,
        paymentDate,
        paymentMethod: "bank_transfer",
      }),
    ).rejects.toThrow(/exceeds outstanding balance/i);

    const [{ total_paid: totalPaid }] = await sql<{ total_paid: string }[]>`
      SELECT coalesce(sum(amount), 0)::text AS total_paid
      FROM payments WHERE org_id = ${ORG_ID} AND invoice_id = ${invoiceId}
    `;
    expect(totalPaid).toBe("100.00");

    const [invoice] = await db
      .select({ amountPaid: invoices.amountPaid })
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, ORG_ID)));
    expect(Number(invoice!.amountPaid)).toBe(100);
  }, 60_000);

  it("records the same amount in the payment register and the allocation subledger", async () => {
    const invoiceId = await newInvoice("200.0000");

    // 100.005 is representable in neither scale-2 nor a double: `.toFixed(2)`
    // gave "100.00" while `.toFixed(4)` gave "100.0050", so the register and the
    // subledger disagreed by half a paisa on the very same receipt.
    const created = await service.recordPayment(ORG_ID, USER_ID, invoiceId, {
      amount: 100.005,
      paymentDate,
      paymentMethod: "bank_transfer",
      allocations: [{ invoiceId, amount: 100.005 }],
    });

    const [paymentRow] = await db
      .select({ amount: payments.amount })
      .from(payments)
      .where(and(eq(payments.id, created.id), eq(payments.orgId, ORG_ID)));
    const [allocationRow] = await db
      .select({ amount: finPaymentAllocations.amount })
      .from(finPaymentAllocations)
      .where(
        and(
          eq(finPaymentAllocations.paymentId, created.id),
          eq(finPaymentAllocations.orgId, ORG_ID),
        ),
      );

    expect(Number(paymentRow!.amount)).toBe(Number(allocationRow!.amount));
    expect(paymentRow!.amount).toBe("100.01");
    expect(allocationRow!.amount).toBe("100.0100");

    // And the ledger receipt agrees with both.
    const [{ receipt }] = await sql<{ receipt: string }[]>`
      SELECT coalesce(sum(jl.debit), 0)::text AS receipt
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id AND je.org_id = jl.org_id
      WHERE je.org_id = ${ORG_ID}
        AND je.source_type = 'payment'
        AND je.source_id = ${String(created.id)}
    `;
    expect(Number(receipt)).toBe(Number(paymentRow!.amount));
  }, 60_000);
});
