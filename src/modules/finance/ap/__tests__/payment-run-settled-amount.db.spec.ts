/**
 * Real-database test for one invariant of an executed payment run: the payment
 * register, the AP subledger and the bill must all record the SAME amount.
 *
 * Guarded by FIN_DB_TESTS=1. Run with:
 *   FIN_DB_TESTS=1 DATABASE_URL=... PGSSLMODE=disable \
 *     npx jest --runInBand --testPathPattern="payment-run-settled-amount.db"
 *
 * Only Postgres shows this. `vendor_payments.amount` is `numeric(12,2)` while
 * `fin_vendor_payment_allocations.amount`, `fin_payment_run_items.amount` and
 * `purchase_bills.amount_paid` are `numeric(18,4)`; a mocked db stores whatever
 * string it is handed at whatever scale, so the divergence only exists once the
 * column types are real. The run item's amount carries three decimals here
 * because `PATCH /finance/payment-runs/:runId/items/:itemId` accepts
 * `z.number().positive()` with no scale constraint (dto/finance-ap.schemas.ts:105).
 *
 * Fixtures live under one throwaway org and are removed in afterAll via
 * ON DELETE CASCADE.
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import {
  finPaymentRunItems,
  finVendorPaymentAllocations,
  purchaseBills,
  vendorPayments,
} from "../../../../db/schema";
import { PaymentRunExecutorService } from "../payment-run-executor.service";
import { JournalPostingService } from "../../../accounting/posting/journal-posting.service";
import { RateResolverService } from "../../controls/rate-resolver.service";
import { FxService } from "../../controls/fx.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

const ENABLED = process.env.FIN_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for FIN_DB_TESTS");
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
const ORG_ID = `fin-run-${SUFFIX}`;
const USER_ID = `fin-run-user-${SUFFIX}`;
/** Three decimals: what the run-item PATCH route accepts and the register cannot hold. */
const ITEM_AMOUNT = "100.0050";
/** The ordinary case: already whole paise, and it must survive the fix untouched. */
const CLEAN_AMOUNT = "250.0000";

describeDb("payment run execution — settled amount agreement", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let executor: PaymentRunExecutorService;
  let user: CurrentUserContext;
  let runId: number;
  let billId: number;
  let cleanBillId: number;

  beforeAll(async () => {
    sql = connect();
    // Only the tables this spec reads; the barrel's namespace import is banned by
    // no-restricted-imports and nothing here uses the relational query API.
    db = drizzle(sql, {
      schema: { finPaymentRunItems, finVendorPaymentAllocations, purchaseBills, vendorPayments },
    }) as unknown as Db;
    const today = new Date().toISOString().slice(0, 10);

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, name, email)
        VALUES (${USER_ID}, 'Payment Run Fixture', ${`${USER_ID}@fixture.invalid`})
      `;
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${ORG_ID}, ${`Payment run ${SUFFIX}`}, ${`payment-run-${SUFFIX}`}, 0)
      `;
      const [member] = await tx`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER_ID}, ${ORG_ID}, 'OWNER', true)
        RETURNING id
      `;
      await tx`UPDATE organizations SET owner_membership_id = ${member!.id} WHERE id = ${ORG_ID}`;
    });

    await sql`INSERT INTO accounting_settings (org_id, base_currency) VALUES (${ORG_ID}, 'INR')`;
    await sql`
      INSERT INTO accounting_periods (org_id, name, start_date, end_date, status)
      VALUES (${ORG_ID}, 'Fixture period', ${`${today.slice(0, 4)}-01-01`}, ${`${today.slice(0, 4)}-12-31`}, 'OPEN')
    `;

    const [bill] = await sql`
      INSERT INTO purchase_bills (org_id, bill_number, bill_date, due_date, subtotal, tax_amount, total, amount_paid, status, currency, exchange_rate, created_by)
      VALUES (${ORG_ID}, ${`BILL-${SUFFIX}`}, ${today}, ${today}, ${ITEM_AMOUNT}, '0.0000', ${ITEM_AMOUNT}, '0.0000', 'POSTED', 'INR', '1.00000000', ${USER_ID})
      RETURNING id
    `;
    billId = Number(bill!.id);

    // A second bill whose amount is already whole paise — the ordinary case, kept
    // in the same run so a fix cannot buy agreement by rounding everything away.
    const [cleanBill] = await sql`
      INSERT INTO purchase_bills (org_id, bill_number, bill_date, due_date, subtotal, tax_amount, total, amount_paid, status, currency, exchange_rate, created_by)
      VALUES (${ORG_ID}, ${`BILL-CLEAN-${SUFFIX}`}, ${today}, ${today}, ${CLEAN_AMOUNT}, '0.0000', ${CLEAN_AMOUNT}, '0.0000', 'POSTED', 'INR', '1.00000000', ${USER_ID})
      RETURNING id
    `;
    cleanBillId = Number(cleanBill!.id);

    const [run] = await sql`
      INSERT INTO fin_payment_runs (org_id, name, scheduled_date, status, total_amount, created_by)
      VALUES (${ORG_ID}, ${`RUN-${SUFFIX}`}, ${today}, 'APPROVED', ${ITEM_AMOUNT}, ${USER_ID})
      RETURNING id
    `;
    runId = Number(run!.id);

    await sql`
      INSERT INTO fin_payment_run_items (org_id, run_id, bill_id, amount, status)
      VALUES (${ORG_ID}, ${runId}, ${billId}, ${ITEM_AMOUNT}, 'PENDING'),
             (${ORG_ID}, ${runId}, ${cleanBillId}, ${CLEAN_AMOUNT}, 'PENDING')
    `;

    const audit = { log: jest.fn() } as unknown as AuditService;
    const dispatch = {
      emit: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationDispatchService;
    const journalPosting = new JournalPostingService(db);
    executor = new PaymentRunExecutorService(
      db,
      audit,
      dispatch,
      journalPosting,
      new RateResolverService(db),
      new FxService({ postJournal: jest.fn() } as never),
    );

    user = {
      userId: USER_ID,
      orgId: ORG_ID,
      role: "ADMIN",
      isOrgOwner: true,
      sessionId: "sess-fixture",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, true),
    };
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM organizations WHERE id = ${ORG_ID}`;
      await sql`DELETE FROM users WHERE id = ${USER_ID}`;
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /** register / allocation / amount_paid / ledger debit, for one bill of the run. */
  async function settledAmountsFor(targetBillId: number) {
    const [payment] = await db
      .select({ id: vendorPayments.id, amount: vendorPayments.amount })
      .from(vendorPayments)
      .where(and(eq(vendorPayments.orgId, ORG_ID), eq(vendorPayments.billId, targetBillId)));
    expect(payment).toBeDefined();

    const [allocation] = await db
      .select({ amount: finVendorPaymentAllocations.amount })
      .from(finVendorPaymentAllocations)
      .where(
        and(
          eq(finVendorPaymentAllocations.orgId, ORG_ID),
          eq(finVendorPaymentAllocations.vendorPaymentId, payment!.id),
        ),
      );

    const [bill] = await db
      .select({ amountPaid: purchaseBills.amountPaid, status: purchaseBills.status })
      .from(purchaseBills)
      .where(and(eq(purchaseBills.orgId, ORG_ID), eq(purchaseBills.id, targetBillId)));

    const ledger = await sql`
      SELECT sum(jl.debit)::text AS debit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id AND je.org_id = jl.org_id
      WHERE je.org_id = ${ORG_ID}
        AND je.source_type = 'vendor_payment'
        AND je.source_id = ${String(payment!.id)}
    `;

    return {
      registeredText: payment!.amount,
      // One economic quantity, four columns, three column scales: compare as numbers.
      registered: Number(payment!.amount),
      allocated: Number(allocation!.amount),
      applied: Number(bill!.amountPaid),
      ledgerDebit: Number(ledger[0]!.debit),
      billStatus: bill!.status,
    };
  }

  it("the payment register, the allocation, the bill and the ledger all record one settled amount", async () => {
    await executor.executeRun(user, runId);

    const items = await db
      .select({ status: finPaymentRunItems.status })
      .from(finPaymentRunItems)
      .where(and(eq(finPaymentRunItems.orgId, ORG_ID), eq(finPaymentRunItems.runId, runId)));
    expect(items.map((i) => i.status)).toEqual(["PAID", "PAID"]);

    const subPaisa = await settledAmountsFor(billId);
    // Rs 100.0050 settles as whole paise, half-up, and every ledger of record agrees.
    expect(subPaisa.registeredText).toBe("100.01");
    expect(subPaisa.allocated).toBe(subPaisa.registered);
    expect(subPaisa.applied).toBe(subPaisa.registered);
    expect(subPaisa.ledgerDebit).toBe(subPaisa.registered);
    expect(subPaisa.billStatus).toBe("PAID");

    const clean = await settledAmountsFor(cleanBillId);
    // The ordinary whole-paise case is untouched.
    expect(clean.registeredText).toBe("250.00");
    expect(clean.allocated).toBe(clean.registered);
    expect(clean.applied).toBe(clean.registered);
    expect(clean.ledgerDebit).toBe(clean.registered);
    expect(clean.billStatus).toBe("PAID");
  }, 60_000);
});
