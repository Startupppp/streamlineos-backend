/**
 * Real-database regression tests for PRD-C125's "immutable invoices" clause,
 * one table below where 0492 left it.
 *
 * `0492_invoice_immutability_trigger.sql` froze the money columns on `invoices`,
 * but `invoice_items` — the lines those totals are the sum of — carried no
 * trigger at all (`select tgname from pg_trigger where tgrelid =
 * 'invoice_items'::regclass and not tgisinternal` returned only
 * `trg_set_org_id`). So an issued invoice's `total` was locked while the lines
 * justifying it could still be rewritten or deleted underneath it, and the
 * invoice would still read as balanced. The only thing stopping it was the
 * application's own `if (existing.status !== "DRAFT") throw` — a guard that runs
 * on a row read BEFORE the transaction opens, so a concurrent issue slips past
 * it.
 *
 * A mock cannot pin this: the defect is the absence of a database trigger, and
 * a mocked `tx.update()` returns whatever it was told to. Only the real UPDATE,
 * refused by the real trigger, shows it.
 *
 * Run with:
 *   PGSSLMODE=disable DATABASE_URL=... \
 *     pnpm test:db-specs --testPathPattern="invoice-item-immutability.db"
 *
 * Everything runs inside a transaction that is rolled back, fixtures included.
 */
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import dotenv from "dotenv";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PG_CHECK_VIOLATION, isCheckViolation } from "../../../common/db/postgres-error";

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

/** The savepoint handle drizzle hands a nested `transaction` callback. */
type NestedTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("invoice-item-immutability.db.spec.ts requires DATABASE_URL");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  return postgres(url.toString(), {
    prepare: false,
    max: 2,
    ssl: process.env.PGSSLMODE === "disable" ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

describe("invoice_items are immutable once their invoice leaves DRAFT — real database", () => {
  let client: ReturnType<typeof connect>;
  let db: Db;

  beforeAll(() => {
    client = connect();
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  interface Fixture {
    tx: Db;
    orgId: string;
    invoiceId: number;
    itemId: number;
    issue: () => Promise<void>;
  }

  /**
   * Creates one DRAFT invoice with one line inside a rolled-back transaction,
   * and hands back a way to move it to ISSUED.
   */
  async function withInvoice<T>(body: (ctx: Fixture) => Promise<T>): Promise<T> {
    let captured: T | undefined;
    try {
      await db.transaction(async (tx) => {
        const [org] = await tx
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .limit(1);
        const [user] = await tx.select({ id: schema.users.id }).from(schema.users).limit(1);
        if (!org || !user)
          throw new Error("invoice-item-immutability.db.spec.ts needs at least one organization and one user");

        const [invoice] = await tx
          .insert(schema.invoices)
          .values({
            orgId: org.id,
            invoiceNumber: `IMMUT-${Date.now()}`,
            status: "DRAFT",
            subtotal: "1000.0000",
            taxRate: "0",
            taxAmount: "180.0000",
            discount: "0",
            total: "1180.0000",
            currency: "INR",
            cgstAmount: "90.0000",
            sgstAmount: "90.0000",
            igstAmount: "0.0000",
            createdBy: user.id,
          })
          .returning({ id: schema.invoices.id });
        if (!invoice) throw new Error("invoice insert returned no rows");

        const [item] = await tx
          .insert(schema.invoiceItems)
          .values({
            invoiceId: invoice.id,
            description: "Onboarding workshop",
            hsnSacCode: "9983",
            quantity: "1.0000",
            rate: "1000.0000",
            gstRate: "18.00",
            amount: "1000.0000",
            lineOrder: 0,
          })
          .returning({ id: schema.invoiceItems.id });
        if (!item) throw new Error("invoice item insert returned no rows");

        captured = await body({
          tx,
          orgId: org.id,
          invoiceId: invoice.id,
          itemId: item.id,
          issue: async () => {
            await tx
              .update(schema.invoices)
              .set({ status: "ISSUED", sentAt: new Date() })
              .where(eq(schema.invoices.id, invoice.id));
          },
        });
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return captured as T;
  }

  /**
   * Runs one statement inside a SAVEPOINT and returns whatever it threw. Without the savepoint the
   * trigger's ERROR poisons the whole fixture transaction ("current transaction is aborted"), and
   * the test could not read the row back to show it was left alone.
   */
  async function capture(tx: Db, statement: (sp: NestedTx) => Promise<unknown>): Promise<unknown> {
    try {
      await tx.transaction(async (sp) => {
        await statement(sp);
      });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("carries the trigger at all — the table used to have only trg_set_org_id", async () => {
    const rows = await db.execute<{ tgname: string }>(sql`
      select tgname from pg_trigger
      where tgrelid = 'invoice_items'::regclass and not tgisinternal
    `);
    const names = [...rows].map((row) => String(row.tgname));
    expect(names).toContain("trg_invoice_item_immutability");
  }, 60_000);

  it("refuses to rewrite a line's amount once the invoice is ISSUED", async () => {
    await withInvoice(async ({ tx, invoiceId, itemId, issue }) => {
      await issue();

      const error = await capture(tx, (sp) =>
        sp
          .update(schema.invoiceItems)
          .set({ amount: "1.0000", rate: "1.0000" })
          .where(eq(schema.invoiceItems.id, itemId)),
      );

      expect(error).toBeDefined();
      expect(isCheckViolation(error)).toBe(true);

      // The line the customer was billed is still the line on the invoice.
      const [row] = await tx
        .select({ amount: schema.invoiceItems.amount })
        .from(schema.invoiceItems)
        .where(eq(schema.invoiceItems.id, itemId));
      expect(Number(row?.amount ?? 0)).toBe(1000);
      expect(invoiceId).toBeGreaterThan(0);
    });
  }, 60_000);

  it("refuses to delete a line once the invoice is ISSUED", async () => {
    await withInvoice(async ({ tx, itemId, issue }) => {
      await issue();

      const error = await capture(tx, (sp) =>
        sp.delete(schema.invoiceItems).where(eq(schema.invoiceItems.id, itemId)),
      );

      expect(error).toBeDefined();
      expect(isCheckViolation(error)).toBe(true);
    });
  }, 60_000);

  it("says which invariant was broken, in a message a caller can act on", async () => {
    await withInvoice(async ({ tx, itemId, issue }) => {
      await issue();

      const error = await capture(tx, (sp) =>
        sp.delete(schema.invoiceItems).where(eq(schema.invoiceItems.id, itemId)),
      );

      let current: unknown = error;
      let message: string | undefined;
      for (let depth = 0; current !== null && typeof current === "object" && depth < 6; depth += 1) {
        if (Reflect.get(current, "code") === PG_CHECK_VIOLATION)
          message = String(Reflect.get(current, "message") ?? "");
        current = Reflect.get(current, "cause");
      }

      expect(message).toMatch(/line items of a non-draft invoice are immutable/i);
      expect(message).toMatch(/credit note/i);
    });
  }, 60_000);

  it("leaves a DRAFT invoice fully editable — the edit path depends on it", async () => {
    await withInvoice(async ({ tx, invoiceId, itemId }) => {
      await tx
        .update(schema.invoiceItems)
        .set({ amount: "2000.0000", rate: "2000.0000" })
        .where(eq(schema.invoiceItems.id, itemId));

      await tx.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invoiceId));

      const remaining = await tx
        .select({ id: schema.invoiceItems.id })
        .from(schema.invoiceItems)
        .where(eq(schema.invoiceItems.invoiceId, invoiceId));
      expect(remaining).toHaveLength(0);
    });
  }, 60_000);

  it("still lets an issued invoice be deleted, cascading its lines with it", async () => {
    await withInvoice(async ({ tx, invoiceId, issue }) => {
      await issue();

      // ON DELETE CASCADE reaches the lines after the parent row is gone. Refusing there would
      // make an issued invoice undeletable and take org deletion and DPDP erasure with it.
      await tx.delete(schema.invoices).where(eq(schema.invoices.id, invoiceId));

      const remaining = await tx
        .select({ id: schema.invoiceItems.id })
        .from(schema.invoiceItems)
        .where(eq(schema.invoiceItems.invoiceId, invoiceId));
      expect(remaining).toHaveLength(0);
    });
  }, 60_000);
});
