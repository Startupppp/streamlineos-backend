/**
 * Anti-corruption layer acceptance tests — PRD 07.
 *
 * The point being proven is that another module can describe what happened in
 * its own vocabulary ("salary expense", "net pay") and land a correct, balanced,
 * idempotent journal without ever naming an account id or touching a table.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import {
  glAccounts,
  glJournals,
  glParties,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService } from "../kernel/sequence.service";
import { PostingCommandService } from "./posting-command.service";
import { AdapterRejection } from "./posting-command.types";

const POSTING_DATE = "2026-08-25";

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let ledger: LedgerService;
let commands: PostingCommandService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

async function seedOrg(): Promise<string> {
  const orgId = `acc-adapter-${crypto.randomUUID()}`;
  const userId = `acc-adapter-u-${crypto.randomUUID()}`;
  createdOrgIds.push(orgId);
  createdUserIds.push(userId);
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id: userId, email: `${userId}@accounting.test` }).onConflictDoNothing();
    await tx
      .insert(organizations)
      .values({ id: orgId, name: orgId, slug: orgId, ownerMembershipId: 0 })
      .onConflictDoNothing();
    const [m] = await tx
      .insert(organizationMembers)
      .values({ orgId, userId, isOwner: true })
      .returning({ id: organizationMembers.id });
    await tx.update(organizations).set({ ownerMembershipId: m.id }).where(eq(organizations.id, orgId));
  });
  return orgId;
}

async function freshBook() {
  const orgId = await seedOrg();
  const book = await books.enable(orgId, null, {
    countryCode: "IN",
    packCode: "IN",
    baseCurrency: "INR",
    openFrom: POSTING_DATE,
  });
  return { orgId, book };
}

async function balances(orgId: string, bookId: string): Promise<Record<string, number>> {
  const rows = await ledger.trialBalance(orgId, bookId, "2027-03-31");
  return Object.fromEntries(rows.map((r) => [r.code, r.balanceMinor]));
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  client = postgres(url, { prepare: false, max: 5 });
  db = drizzle(client, { schema }) as unknown as Db;

  const packs = new PackRegistry();
  const sequences = new SequenceService(db);
  books = new BooksService(db, packs);
  ledger = new LedgerService(db, sequences, packs);
  commands = new PostingCommandService(db, books, ledger);
});

afterAll(async () => {
  if (createdOrgIds.length) await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  await client?.end({ timeout: 5 });
});

/* ------------------------------------------------------------ acceptance 2 */

describe("2 — a payroll run posts a summary journal", () => {
  const payrollRun = (runId: string) => ({
    runId,
    postingDate: POSTING_DATE,
    currency: "INR",
    periodLabel: "June 2026",
    lines: [
      // Payroll thinks in its own vocabulary and in signed amounts.
      { tag: "salary" as const, amountMinor: 5_000_00, description: "Gross salary" },
      { tag: "statutory_payable" as const, amountMinor: -60_000, description: "PF and ESI" },
      { tag: "net_pay_clearing" as const, amountMinor: -440_000, description: "Net pay" },
    ],
  });

  it("maps tags to accounts and moves salary and the payables", async () => {
    const { orgId, book } = await freshBook();

    const result = await commands.submitPayrollRun(orgId, null, payrollRun("run-1"));

    expect(result.replayed).toBe(false);
    const tb = await balances(orgId, book.id);
    expect(tb["5200"]).toBe(500_000); // salaries and wages, debited
    expect(tb["2410"]).toBe(-60_000); // statutory payable, credited
    expect(tb["2400"]).toBe(-440_000); // net pay clearing, credited

    // And the whole thing still balances, because it went through the kernel.
    expect(Object.values(tb).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("does not post twice when the same run is delivered again", async () => {
    const { orgId, book } = await freshBook();

    const first = await commands.submitPayrollRun(orgId, null, payrollRun("run-2"));
    const second = await commands.submitPayrollRun(orgId, null, payrollRun("run-2"));

    expect(second.journalId).toBe(first.journalId);
    expect(second.replayed).toBe(true);

    const journals = await db.select().from(glJournals).where(eq(glJournals.bookId, book.id));
    expect(journals).toHaveLength(1);

    const tb = await balances(orgId, book.id);
    expect(tb["5200"]).toBe(500_000);
  });

  it("stamps the journal with the payroll run as its source", async () => {
    const { orgId, book } = await freshBook();
    const result = await commands.submitPayrollRun(orgId, null, payrollRun("run-3"));

    const journal = await ledger.loadJournal(orgId, result.journalId);
    expect(journal?.sourceType).toBe("payroll_run");
    expect(journal?.sourceId).toBe("run-3");
    expect(journal?.memo).toContain("June 2026");
    expect(book.id).toBe(journal?.bookId);
  });

  it("refuses a run whose own totals do not balance, and says whose fault it is", async () => {
    const { orgId, book } = await freshBook();

    await expect(
      commands.submitPayrollRun(orgId, null, {
        runId: "run-broken",
        postingDate: POSTING_DATE,
        currency: "INR",
        lines: [
          { tag: "salary", amountMinor: 500_000 },
          { tag: "net_pay_clearing", amountMinor: -400_000 },
        ],
      }),
    ).rejects.toMatchObject({ code: "UNBALANCED_COMMAND" });

    // Accounting does not "fix" payroll's arithmetic — nothing was written.
    const journals = await db.select().from(glJournals).where(eq(glJournals.bookId, book.id));
    expect(journals).toHaveLength(0);
  });

  it("refuses a tag the chart has no account for", async () => {
    const { orgId, book } = await freshBook();
    // Remove the account that fills the role, then try to post to it.
    await db
      .update(glAccounts)
      .set({ systemTag: null })
      .where(and(eq(glAccounts.bookId, book.id), eq(glAccounts.systemTag, "net_pay_clearing")));

    await expect(
      commands.submitPayrollRun(orgId, null, {
        runId: "run-untagged",
        postingDate: POSTING_DATE,
        currency: "INR",
        lines: [
          { tag: "salary", amountMinor: 100 },
          { tag: "net_pay_clearing", amountMinor: -100 },
        ],
      }),
    ).rejects.toBeInstanceOf(AdapterRejection);
  });
});

/* ------------------------------------------------------------ acceptance 3 */

describe("3 — reversing a payroll run restores the books", () => {
  it("posts a mirror rather than editing the original", async () => {
    const { orgId, book } = await freshBook();
    const before = await balances(orgId, book.id);

    await commands.submitPayrollRun(orgId, null, {
      runId: "run-reverse",
      postingDate: POSTING_DATE,
      currency: "INR",
      lines: [
        { tag: "salary", amountMinor: 300_000 },
        { tag: "net_pay_clearing", amountMinor: -300_000 },
      ],
    });

    const reversal = await commands.reverse(
      orgId,
      null,
      { sourceType: "payroll_run", sourceId: "run-reverse", purpose: "post" },
      POSTING_DATE,
    );
    expect(reversal).not.toBeNull();

    const after = await balances(orgId, book.id);
    expect(after["5200"] ?? 0).toBe(before["5200"] ?? 0);
    expect(after["2400"] ?? 0).toBe(before["2400"] ?? 0);

    // Two journals exist — the original is intact, not deleted.
    const journals = await db.select().from(glJournals).where(eq(glJournals.bookId, book.id));
    expect(journals).toHaveLength(2);
  });

  it("returns null when there is nothing to reverse", async () => {
    const { orgId } = await freshBook();
    const result = await commands.reverse(
      orgId,
      null,
      { sourceType: "payroll_run", sourceId: "never-posted", purpose: "post" },
      POSTING_DATE,
    );
    expect(result).toBeNull();
  });
});

/* ------------------------------------------------------------ acceptance 4 */

describe("4 — accounting works standalone", () => {
  it("posts without any other module being present or enabled", async () => {
    const { orgId, book } = await freshBook();

    const bank = await db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, book.id), eq(glAccounts.code, "1020")));
    const capital = await db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, book.id), eq(glAccounts.code, "3100")));

    const posted = await ledger.post(orgId, null, {
      bookId: book.id,
      idempotencyKey: "opening_balance:standalone:post",
      journalDate: POSTING_DATE,
      sourceType: "opening_balance",
      lines: [
        { accountId: bank[0].id, debitMinor: 1_000_000 },
        { accountId: capital[0].id, creditMinor: 1_000_000 },
      ],
    });

    expect(posted.id).toBeDefined();
    const tb = await balances(orgId, book.id);
    expect(tb["1020"]).toBe(1_000_000);
  });

  it("refuses politely when accounting was never enabled for the org", async () => {
    const orgId = await seedOrg();

    await expect(
      commands.submitPayrollRun(orgId, null, {
        runId: "run-no-book",
        postingDate: POSTING_DATE,
        currency: "INR",
        lines: [
          { tag: "salary", amountMinor: 100 },
          { tag: "net_pay_clearing", amountMinor: -100 },
        ],
      }),
    ).rejects.toMatchObject({ code: "BOOK_NOT_ENABLED" });
  });
});

/* ------------------------------------------------------------ acceptance 5 */

describe("5 — an external party is reused, never duplicated", () => {
  it("resolves a CRM reference to the same accounting party each time", async () => {
    const { orgId, book } = await freshBook();

    const [party] = await db
      .insert(glParties)
      .values({
        orgId,
        bookId: book.id,
        role: "customer",
        displayName: "Acme Pvt Ltd",
        countryCode: "IN",
        defaultCurrency: "INR",
        externalRefs: [{ system: "crm", id: "company-42" }],
      })
      .returning({ id: glParties.id });

    const receivable = await db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, book.id), eq(glAccounts.code, "1100")));
    const sales = await db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, book.id), eq(glAccounts.code, "4100")));

    const result = await commands.submit(orgId, null, {
      sourceType: "billing_invoice",
      sourceId: "billing-1",
      purpose: "post",
      journalDate: POSTING_DATE,
      lines: [
        {
          accountId: receivable[0].id,
          debitMinor: 100_000,
          partyExternalRef: { system: "crm", id: "company-42" },
        },
        { accountId: sales[0].id, creditMinor: 100_000 },
      ],
    });

    const journal = await ledger.loadJournal(orgId, result.journalId);
    expect(journal).not.toBeNull();

    // Still exactly one party for that CRM company — no shadow duplicate.
    const parties = await db.select().from(glParties).where(eq(glParties.bookId, book.id));
    expect(parties).toHaveLength(1);
    expect(parties[0].id).toBe(party.id);
  });

  it("posts without a party when the external reference is unknown", async () => {
    const { orgId, book } = await freshBook();
    const receivable = await db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, book.id), eq(glAccounts.code, "1100")));
    const sales = await db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, book.id), eq(glAccounts.code, "4100")));

    // An unmatched reference must not block the money from being recorded.
    const result = await commands.submit(orgId, null, {
      sourceType: "billing_invoice",
      sourceId: "billing-unknown",
      purpose: "post",
      journalDate: POSTING_DATE,
      lines: [
        {
          accountId: receivable[0].id,
          debitMinor: 5_000,
          partyExternalRef: { system: "crm", id: "does-not-exist" },
        },
        { accountId: sales[0].id, creditMinor: 5_000 },
      ],
    });

    const journal = await ledger.loadJournal(orgId, result.journalId);
    expect(journal?.lines[0].debitMinor).toBe(5_000);
  });
});

/* -------------------------------------------------------------- structural */

describe("adapter guarantees", () => {
  it("gives every source its own idempotency namespace", async () => {
    const { orgId, book } = await freshBook();

    // Same id, different source type — these are genuinely different events.
    await commands.submitPayrollRun(orgId, null, {
      runId: "shared-id",
      postingDate: POSTING_DATE,
      currency: "INR",
      lines: [
        { tag: "salary", amountMinor: 1_000 },
        { tag: "net_pay_clearing", amountMinor: -1_000 },
      ],
    });

    const receivable = await db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, book.id), eq(glAccounts.code, "1100")));
    const sales = await db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, book.id), eq(glAccounts.code, "4100")));

    await commands.submit(orgId, null, {
      sourceType: "billing_invoice",
      sourceId: "shared-id",
      purpose: "post",
      journalDate: POSTING_DATE,
      lines: [
        { accountId: receivable[0].id, debitMinor: 2_000 },
        { accountId: sales[0].id, creditMinor: 2_000 },
      ],
    });

    const journals = await db.select().from(glJournals).where(eq(glJournals.bookId, book.id));
    expect(journals).toHaveLength(2);
  });

  it("runs several concurrent deliveries of one event to a single journal", async () => {
    const { orgId, book } = await freshBook();
    const run = {
      runId: "run-concurrent",
      postingDate: POSTING_DATE,
      currency: "INR",
      lines: [
        { tag: "salary" as const, amountMinor: 7_000 },
        { tag: "net_pay_clearing" as const, amountMinor: -7_000 },
      ],
    };

    await Promise.allSettled([
      commands.submitPayrollRun(orgId, null, run),
      commands.submitPayrollRun(orgId, null, run),
      commands.submitPayrollRun(orgId, null, run),
    ]);

    const journals = await db.select().from(glJournals).where(eq(glJournals.bookId, book.id));
    expect(journals).toHaveLength(1);
    const tb = await balances(orgId, book.id);
    expect(tb["5200"]).toBe(7_000);
  });
});
