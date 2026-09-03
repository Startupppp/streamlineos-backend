/**
 * Real-database regression tests for editing a DRAFT invoice's line items.
 *
 * Guarded by INV_DB_TESTS=1, the same flag as invoice-numbering.db.spec.ts, so
 * the default hermetic `jest` run is unaffected. Run with:
 *   INV_DB_TESTS=1 DATABASE_URL=... PGSSLMODE=disable \
 *     npx jest --runInBand --testPathPattern="invoice-edit-gst-integrity.db"
 *
 * Why a real database rather than a mock. The defect being pinned is a
 * DISAGREEMENT between three stores of the same fact — the `tax_amount` column,
 * the `cgst/sgst/igst_amount` columns and the `invoice_items.gst_rate` rows —
 * and its consequence is that `postInvoiceSend` builds a journal whose debits
 * and credits differ. A mocked db returns whatever it was told to return for
 * each of those columns, so it can assert the disagreement away. Only the real
 * row, written by the real UPDATE and read back, shows it.
 *
 * Everything runs inside a transaction that is rolled back, fixtures included,
 * so the tests leave the database exactly as they found it.
 *
 * MONEY UNITS. Every amount below is rupees as a decimal string or a JSON
 * number of rupees — the unit the `invoices`/`invoice_items` numeric(18,4)
 * columns and the write DTO both use. No paise-integer conversion happens here.
 */
import { Test } from "@nestjs/testing";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import dotenv from "dotenv";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { JournalPostingService } from "../../accounting/posting/journal-posting.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { InvoicesLifecycleService } from "../invoices-lifecycle.service";
import { InvoicesPaymentService } from "../invoices-payment.service";
import { InvoicesUpdateService } from "../invoices-update.service";
import { InvoicesWriteService } from "../invoices-write.service";
import {
  INVOICE_SEND_SOURCE_EVENT,
  INVOICE_SOURCE_TYPE,
} from "../../accounting/posting/journal-posting.data";

const ENABLED = process.env.INV_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for INV_DB_TESTS");
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

/** Rupees, as the numeric(18,4) columns return them, compared to the paisa. */
function rupees(value: string | null | undefined): number {
  return Math.round(Number(value ?? 0) * 100);
}

describeDb("editing a draft invoice's lines — real database", () => {
  let client: ReturnType<typeof connect>;
  let db: Db;

  beforeAll(() => {
    client = connect();
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  interface Services {
    write: InvoicesWriteService;
    update: InvoicesUpdateService;
  }

  async function buildServices(tx: Db): Promise<Services> {
    const module = await Test.createTestingModule({
      providers: [
        InvoicesWriteService,
        InvoicesUpdateService,
        JournalPostingService,
        { provide: DRIZZLE, useValue: tx },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PlanLimitsService,
          useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: InvoicesLifecycleService, useValue: {} },
        { provide: InvoicesPaymentService, useValue: {} },
      ],
    }).compile();
    return {
      write: module.get(InvoicesWriteService),
      update: module.get(InvoicesUpdateService),
    };
  }

  /** Runs the body inside a rolled-back transaction, scoped to a real tenant. */
  async function withTenant<T>(
    body: (ctx: { tx: Db; orgId: string; userId: string } & Services) => Promise<T>,
  ): Promise<T> {
    let captured: T | undefined;
    try {
      await db.transaction(async (tx) => {
        const [org] = await tx
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .limit(1);
        const [user] = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .limit(1);
        if (!org || !user) {
          throw new Error("INV_DB_TESTS needs at least one organization and one user");
        }
        const services = await buildServices(tx);
        captured = await body({ tx, orgId: org.id, userId: user.id, ...services });
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return captured as T;
  }

  function readInvoice(tx: Db, orgId: string, invoiceId: number) {
    return tx.query.invoices.findFirst({
      where: and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.orgId, orgId)),
    });
  }

  function readItems(tx: Db, invoiceId: number) {
    return tx.query.invoiceItems.findMany({
      where: eq(schema.invoiceItems.invoiceId, invoiceId),
      orderBy: [asc(schema.invoiceItems.lineOrder)],
    });
  }

  it("creates the invoice the edit will corrupt: Rs 1000 @ 18% intra-state", async () => {
    await withTenant(async ({ tx, orgId, userId, write }) => {
      const { invoice } = await write.createInvoice(orgId, userId, {
        items: [
          { description: "Onboarding workshop", hsnSacCode: "9983", quantity: 1, rate: 1000, gstRate: 18 },
        ],
        taxRate: 0,
        discount: 0,
        currency: "INR",
        status: "DRAFT",
      });

      const row = await readInvoice(tx, orgId, invoice.id);
      // Rupees: subtotal 1000, GST pool 180 split 90/90 because supplier state
      // and place of supply agree (both unset on this fixture org).
      expect(rupees(row?.subtotal)).toBe(100_000);
      expect(rupees(row?.taxAmount)).toBe(18_000);
      expect(rupees(row?.cgstAmount)).toBe(9_000);
      expect(rupees(row?.sgstAmount)).toBe(9_000);
      expect(rupees(row?.igstAmount)).toBe(0);
      expect(rupees(row?.total)).toBe(118_000);
      // The blended `tax_rate` column is dead on the create path — it is always "0".
      expect(Number(row?.taxRate ?? 0)).toBe(0);
    });
  }, 60_000);

  it("keeps tax_amount equal to cgst+sgst+igst after a line-item edit", async () => {
    await withTenant(async ({ tx, orgId, userId, write, update }) => {
      const { invoice } = await write.createInvoice(orgId, userId, {
        items: [
          { description: "Onboarding workshop", hsnSacCode: "9983", quantity: 1, rate: 1000, gstRate: 18 },
        ],
        taxRate: 0,
        discount: 0,
        currency: "INR",
        status: "DRAFT",
      });

      // Exactly the body features/billing/invoice-line-items.tsx sends when the
      // user opens Edit and presses Save: the legacy line shape, and taxRate
      // seeded from the stored "0".
      await update.updateInvoice(orgId, userId, invoice.id, {
        lineItems: [
          { description: "Onboarding workshop", quantity: 1, rate: 1000, amount: 1000 },
        ],
        taxRate: 0,
        discount: 0,
        currency: "INR",
      });

      const row = await readInvoice(tx, orgId, invoice.id);
      const split =
        rupees(row?.cgstAmount) + rupees(row?.sgstAmount) + rupees(row?.igstAmount);

      // The GST columns and the tax total are two records of one fact.
      expect(split).toBe(rupees(row?.taxAmount));
      // And the total is the sum of its parts.
      expect(rupees(row?.total)).toBe(
        rupees(row?.subtotal) + rupees(row?.taxAmount) - rupees(row?.discount),
      );
      // The customer is still billed the GST the invoice says it collected.
      expect(rupees(row?.total)).toBe(118_000);
    });
  }, 60_000);

  it("still issues the edited draft, posting a balanced journal", async () => {
    await withTenant(async ({ tx, orgId, userId, write, update }) => {
      const { invoice } = await write.createInvoice(orgId, userId, {
        items: [
          { description: "Onboarding workshop", hsnSacCode: "9983", quantity: 1, rate: 1000, gstRate: 18 },
        ],
        taxRate: 0,
        discount: 0,
        currency: "INR",
        status: "DRAFT",
      });

      await update.updateInvoice(orgId, userId, invoice.id, {
        lineItems: [
          { description: "Onboarding workshop", quantity: 1, rate: 1000, amount: 1000 },
        ],
        taxRate: 0,
        discount: 0,
      });

      // Unbalanced draft lines make persistJournalEntry throw and the whole
      // ISSUE transaction roll back, so the invoice can never leave DRAFT.
      await expect(
        update.updateInvoice(orgId, userId, invoice.id, { status: "ISSUED" }),
      ).resolves.toEqual({ success: true, posted: true });

      const entry = await tx.query.journalEntries.findFirst({
        where: and(
          eq(schema.journalEntries.orgId, orgId),
          eq(schema.journalEntries.sourceType, INVOICE_SOURCE_TYPE),
          eq(schema.journalEntries.sourceId, String(invoice.id)),
          eq(schema.journalEntries.sourceEvent, INVOICE_SEND_SOURCE_EVENT),
        ),
      });
      expect(entry).toBeDefined();

      const lines = await tx.query.journalLines.findMany({
        where: eq(schema.journalLines.entryId, entry!.id),
      });
      const debits = lines.reduce((acc, l) => acc + rupees(l.debit), 0);
      const credits = lines.reduce((acc, l) => acc + rupees(l.credit), 0);
      expect(debits).toBe(credits);

      const row = await readInvoice(tx, orgId, invoice.id);
      expect(row?.status).toBe("ISSUED");
      // Accounts receivable is debited the amount the customer actually owes.
      expect(debits).toBe(rupees(row?.total));
    });
  }, 60_000);

  it("preserves every line's HSN/SAC code and GST rate across an edit", async () => {
    await withTenant(async ({ tx, orgId, userId, write, update }) => {
      const { invoice } = await write.createInvoice(orgId, userId, {
        items: [
          { description: "Consulting", hsnSacCode: "9983", quantity: 1, rate: 1000, gstRate: 18 },
          { description: "Catering", hsnSacCode: "9963", quantity: 2, rate: 100, gstRate: 5 },
        ],
        taxRate: 0,
        discount: 0,
        currency: "INR",
        status: "DRAFT",
      });

      // A pure quantity edit on line 2 — descriptions and order unchanged.
      await update.updateInvoice(orgId, userId, invoice.id, {
        lineItems: [
          { description: "Consulting", quantity: 1, rate: 1000, amount: 1000 },
          { description: "Catering", quantity: 3, rate: 100, amount: 300 },
        ],
        taxRate: 0,
        discount: 0,
      });

      const items = await readItems(tx, invoice.id);
      expect(items.map((i) => i.hsnSacCode)).toEqual(["9983", "9963"]);
      expect(items.map((i) => Number(i.gstRate))).toEqual([18, 5]);

      // Rupees: 1000 @ 18% = 180, 300 @ 5% = 15, pool 195.
      const row = await readInvoice(tx, orgId, invoice.id);
      expect(rupees(row?.subtotal)).toBe(130_000);
      expect(rupees(row?.taxAmount)).toBe(19_500);
      expect(
        rupees(row?.cgstAmount) + rupees(row?.sgstAmount) + rupees(row?.igstAmount),
      ).toBe(19_500);
      expect(rupees(row?.total)).toBe(149_500);
    });
  }, 60_000);

  it("honours a per-line gstRate the caller sends explicitly", async () => {
    await withTenant(async ({ tx, orgId, userId, write, update }) => {
      const { invoice } = await write.createInvoice(orgId, userId, {
        items: [{ description: "Consulting", hsnSacCode: "9983", quantity: 1, rate: 1000, gstRate: 18 }],
        taxRate: 0,
        discount: 0,
        currency: "INR",
        status: "DRAFT",
      });

      // Reclassified to 5% and re-coded, sent explicitly rather than inferred.
      await update.updateInvoice(orgId, userId, invoice.id, {
        lineItems: [
          {
            description: "Consulting",
            quantity: 1,
            rate: 1000,
            amount: 1000,
            gstRate: 5,
            hsnSacCode: "9963",
          },
        ],
        taxRate: 0,
        discount: 0,
      });

      const items = await readItems(tx, invoice.id);
      expect(items.map((i) => Number(i.gstRate))).toEqual([5]);
      expect(items.map((i) => i.hsnSacCode)).toEqual(["9963"]);

      const row = await readInvoice(tx, orgId, invoice.id);
      expect(rupees(row?.taxAmount)).toBe(5_000);
      expect(rupees(row?.cgstAmount)).toBe(2_500);
      expect(rupees(row?.sgstAmount)).toBe(2_500);
      expect(rupees(row?.total)).toBe(105_000);
    });
  }, 60_000);

  it("refuses to guess a tax basis when a taxed line is dropped without one", async () => {
    await withTenant(async ({ tx, orgId, userId, write, update }) => {
      const { invoice } = await write.createInvoice(orgId, userId, {
        items: [
          { description: "Consulting", hsnSacCode: "9983", quantity: 1, rate: 1000, gstRate: 18 },
          { description: "Catering", hsnSacCode: "9963", quantity: 2, rate: 100, gstRate: 5 },
        ],
        taxRate: 0,
        discount: 0,
        currency: "INR",
        status: "DRAFT",
      });

      // Deleting the first line makes positional carry-over a guess: the
      // surviving 5% line would inherit 18%. Refuse rather than mis-tax it.
      await expect(
        update.updateInvoice(orgId, userId, invoice.id, {
          lineItems: [{ description: "Catering", quantity: 2, rate: 100, amount: 200 }],
          taxRate: 0,
          discount: 0,
        }),
      ).rejects.toThrow(/gstRate/);

      // Nothing was written: the invoice is exactly as it was.
      const row = await readInvoice(tx, orgId, invoice.id);
      expect(rupees(row?.subtotal)).toBe(120_000);
      expect(rupees(row?.taxAmount)).toBe(19_000);
      const items = await readItems(tx, invoice.id);
      expect(items).toHaveLength(2);
    });
  }, 60_000);

  it("leaves the legacy blended tax_rate model working when no line is taxed", async () => {
    await withTenant(async ({ tx, orgId, userId, write, update }) => {
      const { invoice } = await write.createInvoice(orgId, userId, {
        items: [{ description: "Consulting", quantity: 1, rate: 1000, gstRate: 0 }],
        taxRate: 0,
        discount: 0,
        currency: "INR",
        status: "DRAFT",
      });

      await update.updateInvoice(orgId, userId, invoice.id, {
        lineItems: [{ description: "Consulting", quantity: 1, rate: 1000, amount: 1000 }],
        taxRate: 18,
        discount: 0,
      });

      const row = await readInvoice(tx, orgId, invoice.id);
      // Rupees: no per-line rate anywhere, so the blended 18% still applies.
      expect(rupees(row?.taxAmount)).toBe(18_000);
      expect(
        rupees(row?.cgstAmount) + rupees(row?.sgstAmount) + rupees(row?.igstAmount),
      ).toBe(18_000);
      expect(rupees(row?.total)).toBe(118_000);
    });
  }, 60_000);
});
