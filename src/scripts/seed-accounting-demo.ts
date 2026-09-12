/**
 * A populated demo company — PRD 09 §P.
 *
 * `reports.e2e-spec.ts` has the golden SeedCo fixture, but nothing a human can
 * run to look at a real set of books. This posts a coherent Indian quarter
 * through the same services the API uses, so what a demo shows is what the
 * product actually produces — and never writes a journal itself.
 *
 * Idempotent: every write is guarded by the natural key it would collide on, so
 * running it twice does not double the books.
 *
 *   pnpm seed:accounting-demo <orgId>
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";
import type { Db } from "../db/drizzle.module";
import { money, toDecimalString } from "../modules/accounting/kernel/money";
import {
  QUARTER_END,
  buildServices,
  enableAccounting,
  isModuleEnabled,
  postOpeningBalances,
  requireOwner,
  type Context,
} from "./accounting-demo/demo-context";
import { seedParties } from "./accounting-demo/demo-parties";
import { seedInvoices, seedReceipts } from "./accounting-demo/demo-sales";
import { seedBills, seedPaymentWithTds } from "./accounting-demo/demo-purchases";
import { seedBankReconciliation, type BankOutcome } from "./accounting-demo/demo-banking";

function normalizeDatabaseUrl(url: string): string {
  if (!/\.neon\.tech/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("channel_binding");
    return parsed.toString();
  } catch {
    return url.replace(/[&?]channel_binding=[^&]*/g, "").replace(/\?&/, "?");
  }
}

/** Trial-balance totals, so a reader can see at a glance the seed made sane books. */
async function summarise(
  ctx: Context,
  banking: BankOutcome,
  moduleEnabled: boolean,
): Promise<boolean> {
  const rows = await ctx.ledger.trialBalance(ctx.orgId, ctx.bookId, QUARTER_END);
  const totalDebitMinor = rows.reduce((a, r) => a + r.debitMinor, 0);
  const totalCreditMinor = rows.reduce((a, r) => a + r.creditMinor, 0);
  const currency = ctx.baseCurrency;
  const balanced = totalDebitMinor === totalCreditMinor;

  const lines = [
    "",
    `Accounting demo seeded for ${ctx.orgId}`,
    `  Book                 ${ctx.bookId} (${currency}, India GST pack)`,
    `  Trial balance as at  ${QUARTER_END}`,
    `    accounts with movement  ${rows.length}`,
    `    total debits            ${toDecimalString(money(totalDebitMinor, currency))} ${currency}`,
    `    total credits           ${toDecimalString(money(totalCreditMinor, currency))} ${currency}`,
    `    balanced                ${balanced ? "yes" : "NO — investigate"}`,
    `  Bank reconciliation  ${banking.reconciled ? "reconciled" : "not reconciled"} — ${banking.explanation}`,
    ...(moduleEnabled
      ? []
      : [
          "  Note: the accounting module is not enabled for this org, so the screens stay",
          "        gated until it is. The books above are correct regardless.",
        ]),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  return balanced;
}

async function main(): Promise<void> {
  const orgId = process.argv[2];
  if (!orgId) throw new Error("Usage: pnpm seed:accounting-demo <orgId>");

  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const connectionString = normalizeDatabaseUrl(raw);
  const isNeon = /\.neon\.tech/i.test(connectionString);
  const client = postgres(connectionString, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: isNeon ? 60 : 30,
    ...(isNeon ? { ssl: "require" as const } : {}),
  });
  const db = drizzle(client, { schema }) as unknown as Db;

  try {
    const userId = await requireOwner(db, orgId);
    const ctx = await enableAccounting(db, buildServices(db), orgId, userId);

    await postOpeningBalances(ctx);
    const parties = await seedParties(ctx);
    const invoices = await seedInvoices(ctx, parties);
    const receiptIds = await seedReceipts(ctx, parties, invoices);
    const bills = await seedBills(ctx, parties);
    const paymentId = await seedPaymentWithTds(ctx, parties, bills);
    const banking = await seedBankReconciliation(ctx, receiptIds, paymentId);

    const moduleEnabled = await isModuleEnabled(db, orgId);
    if (!(await summarise(ctx, banking, moduleEnabled))) {
      throw new Error("The seeded books do not balance");
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(
      `[seed-accounting-demo] failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
