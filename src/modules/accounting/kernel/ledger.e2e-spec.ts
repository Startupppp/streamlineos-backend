/**
 * Ledger kernel acceptance suite — the hard gate from `01-prd-ledger-kernel.md`.
 *
 * No other accounting PRD is considered implemented until every test here is
 * green. These run against a real Postgres because half of what is being proven
 * (check constraints, partial uniques, concurrent idempotency) does not exist in
 * a mock.
 *
 * Services are constructed directly rather than through Nest DI — the kernel has
 * no request context and booting `AppModule` would take longer than the suite.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import {
  glAccounts,
  glBookCurrencies,
  glJournalLines,
  glJournals,
  glPeriods,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "./books.service";
import { LedgerService } from "./ledger.service";
import { SequenceService } from "./sequence.service";
import { LedgerRejection } from "./ledger.types";
import { convert, money } from "./money";

const JOURNAL_DATE = "2026-08-25";
const USER_ID = null;

let client: ReturnType<typeof postgres>;
let db: Db;
let ledger: LedgerService;
let books: BooksService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * Create a tenant the way the platform really does.
 *
 * `organizations.owner_membership_id` carries a composite FK back to
 * `organization_members`, so the two rows are mutually dependent. The
 * constraint is DEFERRABLE INITIALLY DEFERRED precisely for this — insert both
 * inside one transaction and it is checked at commit.
 */
async function seedOrg(): Promise<string> {
  const orgId = `acc-test-${crypto.randomUUID()}`;
  const userId = `acc-user-${crypto.randomUUID()}`;
  createdOrgIds.push(orgId);
  createdUserIds.push(userId);

  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ id: userId, email: `${userId}@accounting.test` })
      .onConflictDoNothing();
    await tx
      .insert(organizations)
      .values({ id: orgId, name: orgId, slug: orgId, ownerMembershipId: 0 })
      .onConflictDoNothing();
    const [membership] = await tx
      .insert(organizationMembers)
      .values({ orgId, userId, isOwner: true })
      .returning({ id: organizationMembers.id });
    await tx
      .update(organizations)
      .set({ ownerMembershipId: membership.id })
      .where(eq(organizations.id, orgId));
  });

  return orgId;
}

/** A fresh org with accounting enabled, isolated from every other test. */
async function freshBook(pack = "IN", currency = "INR") {
  const orgId = await seedOrg();

  const book = await books.enable(orgId, USER_ID, {
    countryCode: pack === "IN" ? "IN" : "US",
    packCode: pack,
    baseCurrency: currency,
    openFrom: JOURNAL_DATE,
  });
  return { orgId, book };
}

/** A book only trades in currencies it has enabled (PRD 11 M4). */
async function enableCurrency(orgId: string, bookId: string, currencyCode: string): Promise<void> {
  await db
    .insert(glBookCurrencies)
    .values({ orgId, bookId, currencyCode, isBase: false })
    .onConflictDoNothing();
}

async function accountId(bookId: string, code: string): Promise<string> {
  const [row] = await db
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(and(eq(glAccounts.bookId, bookId), eq(glAccounts.code, code)))
    .limit(1);
  if (!row) throw new Error(`Test fixture is missing account ${code}`);
  return row.id;
}

/** Trial balance as a code -> signed balance map, for terse assertions. */
async function trialBalance(orgId: string, bookId: string): Promise<Record<string, number>> {
  const rows = await ledger.trialBalance(orgId, bookId, "2027-03-31");
  return Object.fromEntries(rows.map((r) => [r.code, r.balanceMinor]));
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for the ledger acceptance suite");
  client = postgres(url, { prepare: false, max: 5 });
  db = drizzle(client, { schema }) as unknown as Db;

  const packs = new PackRegistry();
  const sequences = new SequenceService(db);
  books = new BooksService(db, packs);
  ledger = new LedgerService(db, sequences, packs);
});

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    // Everything accounting owns cascades from the org row.
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await client?.end({ timeout: 5 });
});

/* ------------------------------------------------------------ acceptance 1 */

describe("1 — a balanced journal posts and reaches the trial balance", () => {
  it("posts two lines and moves both accounts", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:seed-capital:post",
      journalDate: JOURNAL_DATE,
      memo: "Founder capital",
      sourceType: "opening_balance",
      lines: [
        { accountId: bank, debitMinor: 10_000_000 },
        { accountId: capital, creditMinor: 10_000_000 },
      ],
    });

    expect(posted.replayed).toBe(false);
    expect(posted.totalDebitMinor).toBe(posted.totalCreditMinor);
    expect(posted.lines).toHaveLength(2);
    expect(posted.journalNumber).toMatch(/^JV\/2026-27\/\d{4}$/);
    expect(posted.functionalCurrency).toBe("INR");

    const tb = await trialBalance(orgId, book.id);
    expect(tb["1020"]).toBe(10_000_000);
    expect(tb["3100"]).toBe(-10_000_000);

    // The whole trial balance nets to zero, which is the invariant that matters.
    const total = Object.values(tb).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });

  it("stamps the period, the source and the poster", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:stamp:post",
      journalDate: JOURNAL_DATE,
      sourceType: "manual",
      sourceId: "fixture-1",
      lines: [
        { accountId: bank, debitMinor: 500 },
        { accountId: capital, creditMinor: 500 },
      ],
    });

    const [period] = await db
      .select({ name: glPeriods.name })
      .from(glPeriods)
      .where(eq(glPeriods.id, posted.periodId));
    expect(period.name).toBe("August 2026");
    expect(posted.sourceType).toBe("manual");
    expect(posted.sourceId).toBe("fixture-1");
    expect(posted.postedAt).toBeInstanceOf(Date);
  });
});

/* ------------------------------------------------------------ acceptance 2 */

describe("2 — an unbalanced command is rejected and writes nothing", () => {
  it("rejects debits that do not equal credits", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:unbalanced:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: bank, debitMinor: 10_000 },
          { accountId: capital, creditMinor: 9_999 },
        ],
      }),
    ).rejects.toMatchObject({ code: "UNBALANCED" });

    const rows = await db.select().from(glJournals).where(eq(glJournals.orgId, orgId));
    expect(rows).toHaveLength(0);
  });

  it("rejects a zero-line journal", async () => {
    const { orgId, book } = await freshBook();
    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:empty:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [],
      }),
    ).rejects.toMatchObject({ code: "EMPTY_JOURNAL" });
  });

  it("rejects a line carrying both a debit and a credit", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:both-sides:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [{ accountId: bank, debitMinor: 100, creditMinor: 100 }],
      }),
    ).rejects.toMatchObject({ code: "LINE_SIDE_INVALID" });
  });

  it("rejects a line carrying neither a debit nor a credit", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:no-sides:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [{ accountId: bank, debitMinor: 0, creditMinor: 0 }],
      }),
    ).rejects.toMatchObject({ code: "LINE_SIDE_INVALID" });
  });

  it("rejects a negative amount", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");
    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:negative:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: bank, debitMinor: -100 },
          { accountId: capital, creditMinor: -100 },
        ],
      }),
    ).rejects.toMatchObject({ code: "LINE_AMOUNT_INVALID" });
  });
});

/* ------------------------------------------------------------ acceptance 3 */

describe("3 — a header account cannot be posted to", () => {
  it("rejects a posting against a group header", async () => {
    const { orgId, book } = await freshBook();
    const assetsHeader = await accountId(book.id, "1000");
    const capital = await accountId(book.id, "3100");

    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:header:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: assetsHeader, debitMinor: 100 },
          { accountId: capital, creditMinor: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_IS_HEADER", lineIndex: 0 });
  });

  it("rejects a posting against an inactive account", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");
    await db.update(glAccounts).set({ isActive: false }).where(eq(glAccounts.id, bank));

    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:inactive:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: bank, debitMinor: 100 },
          { accountId: capital, creditMinor: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
  });
});

/* ------------------------------------------------------------ acceptance 4 */

describe("4 — a locked period refuses postings", () => {
  it("rejects a journal dated into a locked period", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    await db
      .update(glPeriods)
      .set({ status: "LOCKED" })
      .where(and(eq(glPeriods.bookId, book.id), eq(glPeriods.name, "August 2026")));

    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:locked:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: bank, debitMinor: 100 },
          { accountId: capital, creditMinor: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: "PERIOD_LOCKED" });

    // The neighbouring period is untouched and still accepts work.
    const ok = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:unlocked-neighbour:post",
      journalDate: "2026-09-15",
      sourceType: "manual",
      lines: [
        { accountId: bank, debitMinor: 100 },
        { accountId: capital, creditMinor: 100 },
      ],
    });
    expect(ok.id).toBeDefined();
  });

  it("rejects a date no period covers rather than inventing one", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:no-period:post",
        // Two fiscal years ahead of anything opened.
        journalDate: "2029-01-15",
        sourceType: "manual",
        lines: [
          { accountId: bank, debitMinor: 100 },
          { accountId: capital, creditMinor: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: "PERIOD_NOT_FOUND" });
  });
});

/* ------------------------------------------------------------ acceptance 5 */

describe("5 — a posted journal is immutable", () => {
  it("exposes no update or delete path on the kernel", () => {
    const surface = ledger as unknown as Record<string, unknown>;
    expect(surface.update).toBeUndefined();
    expect(surface.updateJournal).toBeUndefined();
    expect(surface.delete).toBeUndefined();
    expect(surface.deleteJournal).toBeUndefined();
    expect(typeof surface.post).toBe("function");
    expect(typeof surface.reverse).toBe("function");
  });

  it("refuses at the database even if a caller reaches around the service", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:immutable:post",
      journalDate: JOURNAL_DATE,
      sourceType: "manual",
      lines: [
        { accountId: bank, debitMinor: 1_000 },
        { accountId: capital, creditMinor: 1_000 },
      ],
    });

    // Unbalancing a line by hand violates the CHECK that both sides cannot be
    // set, so the write is refused rather than quietly corrupting the books.
    await expect(
      db
        .update(glJournalLines)
        .set({ creditMinor: 500 })
        .where(and(eq(glJournalLines.journalId, posted.id), eq(glJournalLines.accountId, bank))),
    ).rejects.toThrow();

    // And the functional amount cannot drift away from the posted side.
    await expect(
      db
        .update(glJournalLines)
        .set({ debitMinor: 999 })
        .where(and(eq(glJournalLines.journalId, posted.id), eq(glJournalLines.accountId, bank))),
    ).rejects.toThrow();

    const tb = await trialBalance(orgId, book.id);
    expect(tb["1020"]).toBe(1_000);
  });
});

/* ------------------------------------------------------------ acceptance 6 */

describe("6 — reversing restores the trial balance", () => {
  it("mirrors every line and nets the books back to where they were", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const revenue = await accountId(book.id, "4100");
    const receivable = await accountId(book.id, "1100");

    const before = await trialBalance(orgId, book.id);

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "sales_invoice:INV-1:post",
      journalDate: JOURNAL_DATE,
      sourceType: "sales_invoice",
      sourceId: "INV-1",
      lines: [
        { accountId: receivable, debitMinor: 11_800 },
        { accountId: revenue, creditMinor: 11_800 },
      ],
    });

    const during = await trialBalance(orgId, book.id);
    expect(during["1100"]).toBe(11_800);

    const reversal = await ledger.reverse(orgId, USER_ID, {
      bookId: book.id,
      journalId: posted.id,
      idempotencyKey: "sales_invoice:INV-1:reverse",
    });

    expect(reversal.reversesJournalId).toBe(posted.id);
    expect(reversal.lines).toHaveLength(posted.lines.length);
    // Debits and credits swapped, amounts identical.
    expect(reversal.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual(
      posted.lines.map((l) => [l.accountId, l.creditMinor, l.debitMinor]),
    );

    const after = await trialBalance(orgId, book.id);
    expect(after["1100"] ?? 0).toBe(before["1100"] ?? 0);
    expect(after["4100"] ?? 0).toBe(before["4100"] ?? 0);
    expect(bank).toBeDefined();
  });

  it("leaves the original journal intact and links the pair", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:linked:post",
      journalDate: JOURNAL_DATE,
      sourceType: "manual",
      lines: [
        { accountId: bank, debitMinor: 700 },
        { accountId: capital, creditMinor: 700 },
      ],
    });

    const reversal = await ledger.reverse(orgId, USER_ID, {
      bookId: book.id,
      journalId: posted.id,
      idempotencyKey: "manual:linked:reverse",
    });

    const original = await ledger.loadJournal(orgId, posted.id);
    expect(original?.reversedByJournalId).toBe(reversal.id);
    expect(original?.journalNumber).toBe(posted.journalNumber);
    expect(original?.lines).toHaveLength(2);
    expect(original?.totalDebitMinor).toBe(700);
  });

  it("refuses to reverse the same journal twice", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:double-reverse:post",
      journalDate: JOURNAL_DATE,
      sourceType: "manual",
      lines: [
        { accountId: bank, debitMinor: 100 },
        { accountId: capital, creditMinor: 100 },
      ],
    });

    await ledger.reverse(orgId, USER_ID, {
      bookId: book.id,
      journalId: posted.id,
      idempotencyKey: "manual:double-reverse:reverse-1",
    });

    await expect(
      ledger.reverse(orgId, USER_ID, {
        bookId: book.id,
        journalId: posted.id,
        idempotencyKey: "manual:double-reverse:reverse-2",
      }),
    ).rejects.toMatchObject({ code: "ALREADY_REVERSED" });
  });

  it("allows reversing a reversal, which nets back to the original", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:re-reverse:post",
      journalDate: JOURNAL_DATE,
      sourceType: "manual",
      lines: [
        { accountId: bank, debitMinor: 2_500 },
        { accountId: capital, creditMinor: 2_500 },
      ],
    });

    const reversal = await ledger.reverse(orgId, USER_ID, {
      bookId: book.id,
      journalId: posted.id,
      idempotencyKey: "manual:re-reverse:reverse",
    });

    await ledger.reverse(orgId, USER_ID, {
      bookId: book.id,
      journalId: reversal.id,
      idempotencyKey: "manual:re-reverse:reverse-again",
    });

    const tb = await trialBalance(orgId, book.id);
    expect(tb["1020"]).toBe(2_500);
    expect(tb["3100"]).toBe(-2_500);
  });

  it("refuses to reverse into a locked period", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:reverse-locked:post",
      journalDate: JOURNAL_DATE,
      sourceType: "manual",
      lines: [
        { accountId: bank, debitMinor: 100 },
        { accountId: capital, creditMinor: 100 },
      ],
    });

    await db
      .update(glPeriods)
      .set({ status: "LOCKED" })
      .where(and(eq(glPeriods.bookId, book.id), eq(glPeriods.name, "August 2026")));

    await expect(
      ledger.reverse(orgId, USER_ID, {
        bookId: book.id,
        journalId: posted.id,
        idempotencyKey: "manual:reverse-locked:reverse",
      }),
    ).rejects.toMatchObject({ code: "PERIOD_LOCKED" });
  });
});

/* ------------------------------------------------------------ acceptance 7 */

describe("7 — idempotency is binary: zero or one journal per key", () => {
  it("returns the original on a repeated key without posting again", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const command = {
      bookId: book.id,
      idempotencyKey: "sales_invoice:INV-9:post",
      journalDate: JOURNAL_DATE,
      sourceType: "sales_invoice" as const,
      sourceId: "INV-9",
      lines: [
        { accountId: bank, debitMinor: 5_000 },
        { accountId: capital, creditMinor: 5_000 },
      ],
    };

    const first = await ledger.post(orgId, USER_ID, command);
    const second = await ledger.post(orgId, USER_ID, command);

    expect(second.id).toBe(first.id);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);

    const rows = await db.select().from(glJournals).where(eq(glJournals.bookId, book.id));
    expect(rows).toHaveLength(1);

    const tb = await trialBalance(orgId, book.id);
    expect(tb["1020"]).toBe(5_000);
  });

  it("survives a genuine double-click, both requests in flight at once", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const command = {
      bookId: book.id,
      idempotencyKey: "sales_invoice:INV-RACE:post",
      journalDate: JOURNAL_DATE,
      sourceType: "sales_invoice" as const,
      lines: [
        { accountId: bank, debitMinor: 3_300 },
        { accountId: capital, creditMinor: 3_300 },
      ],
    };

    const results = await Promise.allSettled([
      ledger.post(orgId, USER_ID, command),
      ledger.post(orgId, USER_ID, command),
      ledger.post(orgId, USER_ID, command),
    ]);

    // Every caller must succeed. An earlier version of this test accepted "at
    // least one" and so tolerated the loser of the insert race throwing — which
    // is exactly the bug that hid: Drizzle wraps the driver error, so the
    // unique-violation branch never recognised it and a double-click 500'd.
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);

    const journalIds = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof ledger.post>>> =>
        r.status === "fulfilled")
      .map((r) => r.value.id);
    // All three describe the same journal.
    expect(new Set(journalIds).size).toBe(1);

    const rows = await db.select().from(glJournals).where(eq(glJournals.bookId, book.id));
    expect(rows).toHaveLength(1);

    const tb = await trialBalance(orgId, book.id);
    expect(tb["1020"]).toBe(3_300);
  });
});

/* ------------------------------------------------------------ acceptance 8 */

describe("8 — a foreign-currency journal on INR books", () => {
  it("stores the transaction amount in USD and balances in INR", async () => {
    const { orgId, book } = await freshBook();
    await enableCurrency(orgId, book.id, "USD");
    const receivable = await accountId(book.id, "1100");
    const revenue = await accountId(book.id, "4100");

    // $1,000.00 invoiced at 83.25 INR/USD.
    const usd = money(100_000, "USD");
    const inr = convert(usd, "INR", "83.25");
    expect(inr.minor).toBe(8_325_000);

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "sales_invoice:INV-USD:post",
      journalDate: JOURNAL_DATE,
      sourceType: "sales_invoice",
      lines: [
        {
          accountId: receivable,
          debitMinor: inr.minor,
          txnCurrency: "USD",
          txnAmountMinor: usd.minor,
          fxRate: "83.25",
        },
        {
          accountId: revenue,
          creditMinor: inr.minor,
          txnCurrency: "USD",
          txnAmountMinor: usd.minor,
          fxRate: "83.25",
        },
      ],
    });

    expect(posted.totalDebitMinor).toBe(posted.totalCreditMinor);
    for (const line of posted.lines) {
      expect(line.txnCurrency).toBe("USD");
      expect(line.txnAmountMinor).toBe(100_000);
      expect(line.functionalCurrency).toBe("INR");
      expect(line.functionalAmountMinor).toBe(8_325_000);
      expect(Number(line.fxRate)).toBe(83.25);
    }

    const tb = await trialBalance(orgId, book.id);
    expect(tb["1100"]).toBe(8_325_000);
    expect(Object.values(tb).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("rejects a base-currency line that claims a rate other than 1", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:bad-rate:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: bank, debitMinor: 100, txnCurrency: "INR", txnAmountMinor: 100, fxRate: "1.1" },
          { accountId: capital, creditMinor: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: "FX_RATE_INVALID" });
  });

  it("rejects a foreign line with no usable rate", async () => {
    const { orgId, book } = await freshBook();
    await enableCurrency(orgId, book.id, "USD");
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:missing-rate:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: bank, debitMinor: 8_325, txnCurrency: "USD", txnAmountMinor: 100, fxRate: "0" },
          { accountId: capital, creditMinor: 8_325 },
        ],
      }),
    ).rejects.toMatchObject({ code: "FX_RATE_INVALID" });
  });

  it("refuses a currency the book does not trade in", async () => {
    const { orgId, book } = await freshBook();
    const receivable = await accountId(book.id, "1100");
    const revenue = await accountId(book.id, "4100");

    // JPY was never enabled on this book. Without the check a typo would open a
    // phantom currency exposure nobody asked for.
    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:unenabled-ccy:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          {
            accountId: receivable,
            debitMinor: 8_325,
            txnCurrency: "JPY",
            txnAmountMinor: 100,
            fxRate: "83.25",
          },
          { accountId: revenue, creditMinor: 8_325 },
        ],
      }),
    ).rejects.toMatchObject({ code: "CURRENCY_INVALID" });
  });

  it("allows mixed transaction currencies as long as the book balances", async () => {
    const { orgId, book } = await freshBook();
    await enableCurrency(orgId, book.id, "USD");
    const receivable = await accountId(book.id, "1100");
    const revenue = await accountId(book.id, "4100");

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:mixed-ccy:post",
      journalDate: JOURNAL_DATE,
      sourceType: "manual",
      lines: [
        {
          accountId: receivable,
          debitMinor: 8_325,
          txnCurrency: "USD",
          txnAmountMinor: 100,
          fxRate: "83.25",
        },
        { accountId: revenue, creditMinor: 8_325 },
      ],
    });

    expect(posted.lines[0].txnCurrency).toBe("USD");
    expect(posted.lines[1].txnCurrency).toBe("INR");
    expect(posted.totalDebitMinor).toBe(posted.totalCreditMinor);
  });
});

/* ------------------------------------------------------------ acceptance 9 */

describe("9 — cross-tenant ids are rejected", () => {
  it("refuses an account belonging to another org's book", async () => {
    const mine = await freshBook();
    const theirs = await freshBook();

    const myCapital = await accountId(mine.book.id, "3100");
    const theirBank = await accountId(theirs.book.id, "1020");

    await expect(
      ledger.post(mine.orgId, USER_ID, {
        bookId: mine.book.id,
        idempotencyKey: "manual:cross-tenant:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: theirBank, debitMinor: 100 },
          { accountId: myCapital, creditMinor: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });

    const rows = await db.select().from(glJournals).where(eq(glJournals.orgId, mine.orgId));
    expect(rows).toHaveLength(0);
  });

  it("refuses a book belonging to another org", async () => {
    const mine = await freshBook();
    const theirs = await freshBook();
    const theirBank = await accountId(theirs.book.id, "1020");

    await expect(
      ledger.post(mine.orgId, USER_ID, {
        bookId: theirs.book.id,
        idempotencyKey: "manual:cross-book:post",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [{ accountId: theirBank, debitMinor: 100 }],
      }),
    ).rejects.toMatchObject({ code: "BOOK_NOT_FOUND" });
  });

  it("does not leak another org's journal through loadJournal", async () => {
    const mine = await freshBook();
    const theirs = await freshBook();
    const theirBank = await accountId(theirs.book.id, "1020");
    const theirCapital = await accountId(theirs.book.id, "3100");

    const posted = await ledger.post(theirs.orgId, USER_ID, {
      bookId: theirs.book.id,
      idempotencyKey: "manual:theirs:post",
      journalDate: JOURNAL_DATE,
      sourceType: "manual",
      lines: [
        { accountId: theirBank, debitMinor: 100 },
        { accountId: theirCapital, creditMinor: 100 },
      ],
    });

    expect(await ledger.loadJournal(mine.orgId, posted.id)).toBeNull();
    expect(await ledger.loadJournal(theirs.orgId, posted.id)).not.toBeNull();
  });
});

/* ----------------------------------------------------------- acceptance 10 */

describe("10 — concurrent posts under different keys both land", () => {
  it("sums both into the trial balance", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const make = (key: string, amount: number) =>
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: key,
        journalDate: JOURNAL_DATE,
        sourceType: "manual" as const,
        lines: [
          { accountId: bank, debitMinor: amount },
          { accountId: capital, creditMinor: amount },
        ],
      });

    const [a, b, c] = await Promise.all([
      make("manual:concurrent-a:post", 100),
      make("manual:concurrent-b:post", 250),
      make("manual:concurrent-c:post", 375),
    ]);

    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    // Numbering stayed unique under contention.
    expect(new Set([a.journalNumber, b.journalNumber, c.journalNumber]).size).toBe(3);

    const tb = await trialBalance(orgId, book.id);
    expect(tb["1020"]).toBe(725);
    expect(tb["3100"]).toBe(-725);
  });
});

/* ------------------------------------------------------ acceptance 11 & 12 */

describe("11 — the India pack seeds a usable chart", () => {
  it("has cash, receivable, payable, equity, income, expense and GST accounts", async () => {
    const { book } = await freshBook("IN", "INR");
    const rows = await db
      .select({
        code: glAccounts.code,
        systemTag: glAccounts.systemTag,
        isHeader: glAccounts.isHeader,
        isCash: glAccounts.isCash,
        accountType: glAccounts.accountType,
      })
      .from(glAccounts)
      .where(eq(glAccounts.bookId, book.id));

    const tags = new Set(rows.map((r) => r.systemTag).filter(Boolean));
    for (const required of [
      "cash",
      "bank",
      "ar_control",
      "ap_control",
      "equity_capital",
      "retained_earnings",
      "sales",
      "opex",
      "gst_input_cgst",
      "gst_input_sgst",
      "gst_input_igst",
      "gst_output_cgst",
      "gst_output_sgst",
      "gst_output_igst",
    ]) {
      expect(tags).toContain(required);
    }

    // Headers exist and are marked as such, so they cannot receive postings.
    const headers = rows.filter((r) => r.isHeader).map((r) => r.code);
    expect(headers).toEqual(expect.arrayContaining(["1000", "2000", "3000", "4000", "5000"]));

    // Cash accounts are flagged for banking to find (PRD 04 M1).
    expect(rows.filter((r) => r.isCash).length).toBeGreaterThanOrEqual(2);

    // Every one of the seven account types the kernel understands is reachable.
    expect(new Set(rows.map((r) => r.accountType))).toEqual(
      new Set(["ASSET", "CONTRA_ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]),
    );
  });

  it("parents its children onto the right headers", async () => {
    const { book } = await freshBook("IN", "INR");
    const rows = await db
      .select({ code: glAccounts.code, parentAccountId: glAccounts.parentAccountId })
      .from(glAccounts)
      .where(eq(glAccounts.bookId, book.id));

    const assetsHeaderId = await accountId(book.id, "1000");
    const bankRow = rows.find((r) => r.code === "1020");
    expect(bankRow?.parentAccountId).toBe(assetsHeaderId);
  });

  it("does not duplicate accounts when accounting is enabled twice", async () => {
    const orgId = await seedOrg();

    const first = await books.enable(orgId, USER_ID, {
      countryCode: "IN",
      openFrom: JOURNAL_DATE,
    });
    const second = await books.enable(orgId, USER_ID, {
      countryCode: "IN",
      openFrom: JOURNAL_DATE,
    });

    expect(second.id).toBe(first.id);

    const cash = await db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, first.id), eq(glAccounts.code, "1010")));
    expect(cash).toHaveLength(1);

    // And exactly one fiscal year with twelve periods, not two sets.
    const periods = await db
      .select({ id: glPeriods.id })
      .from(glPeriods)
      .where(eq(glPeriods.bookId, first.id));
    expect(periods).toHaveLength(12);
  });
});

describe("12 — a non-India pack needs no GST accounts", () => {
  it("seeds US books with sales tax payable and no CGST", async () => {
    const { book } = await freshBook("US", "USD");
    expect(book.baseCurrency).toBe("USD");
    expect(book.localizationPack).toBe("US");

    const rows = await db
      .select({ code: glAccounts.code, systemTag: glAccounts.systemTag })
      .from(glAccounts)
      .where(eq(glAccounts.bookId, book.id));

    const tags = new Set(rows.map((r) => r.systemTag).filter(Boolean));
    expect(tags).toContain("sales_tax_payable");
    expect(tags).toContain("ar_control");
    expect(tags).not.toContain("gst_output_cgst");
    expect(tags).not.toContain("gst_input_cgst");
  });

  it("opens a calendar fiscal year for a calendar-year pack", async () => {
    const { book, orgId } = await freshBook("US", "USD");
    const fy = await books.ensureFiscalYear(orgId, book.id, JOURNAL_DATE);
    expect(fy.name).toBe("2026");
    expect(fy.startsOn).toBe("2026-01-01");
    expect(fy.endsOn).toBe("2026-12-31");
  });

  it("posts in the book's own currency at rate 1", async () => {
    const { orgId, book } = await freshBook("US", "USD");
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:usd-book:post",
      journalDate: JOURNAL_DATE,
      sourceType: "manual",
      lines: [
        { accountId: bank, debitMinor: 250_000 },
        { accountId: capital, creditMinor: 250_000 },
      ],
    });

    expect(posted.functionalCurrency).toBe("USD");
    expect(posted.lines[0].txnCurrency).toBe("USD");
    expect(Number(posted.lines[0].fxRate)).toBe(1);
    // Continuous series, no fiscal-year segment.
    expect(posted.journalNumber).toMatch(/^JV-\d{5}$/);
  });
});

/* ------------------------------------------------------------- structural */

describe("kernel guarantees that are not tied to one acceptance test", () => {
  it("requires an idempotency key", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "   ",
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [{ accountId: bank, debitMinor: 100 }],
      }),
    ).rejects.toBeInstanceOf(LedgerRejection);
  });

  it("rejects a malformed journal date", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");
    await expect(
      ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: "manual:bad-date:post",
        journalDate: "25/08/2026",
        sourceType: "manual",
        lines: [
          { accountId: bank, debitMinor: 100 },
          { accountId: capital, creditMinor: 100 },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerRejection);
  });

  it("numbers journals uniquely and sequentially within a book", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const posted = await ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: `manual:seq-${i}:post`,
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: bank, debitMinor: 100 },
          { accountId: capital, creditMinor: 100 },
        ],
      });
      numbers.push(posted.journalNumber);
    }

    expect(numbers).toEqual(["JV/2026-27/0001", "JV/2026-27/0002", "JV/2026-27/0003"]);
  });

  it("keeps a trial balance that sums to zero after arbitrary activity", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const receivable = await accountId(book.id, "1100");
    const revenue = await accountId(book.id, "4100");
    const rent = await accountId(book.id, "5310");
    const payable = await accountId(book.id, "2100");

    const entries: Array<[string, string, string, number]> = [
      ["manual:mix-1:post", receivable, revenue, 50_000],
      ["manual:mix-2:post", bank, receivable, 30_000],
      ["manual:mix-3:post", rent, payable, 12_000],
    ];

    for (const [key, debit, credit, amount] of entries) {
      await ledger.post(orgId, USER_ID, {
        bookId: book.id,
        idempotencyKey: key,
        journalDate: JOURNAL_DATE,
        sourceType: "manual",
        lines: [
          { accountId: debit, debitMinor: amount },
          { accountId: credit, creditMinor: amount },
        ],
      });
    }

    const rows = await ledger.trialBalance(orgId, book.id, "2027-03-31");
    const debits = rows.reduce((a, r) => a + r.debitMinor, 0);
    const credits = rows.reduce((a, r) => a + r.creditMinor, 0);
    expect(debits).toBe(credits);
    expect(rows.reduce((a, r) => a + r.balanceMinor, 0)).toBe(0);

    const tb = Object.fromEntries(rows.map((r) => [r.code, r.balanceMinor]));
    expect(tb["1020"]).toBe(30_000);
    expect(tb["1100"]).toBe(20_000);
    expect(tb["4100"]).toBe(-50_000);
    expect(tb["5310"]).toBe(12_000);
    expect(tb["2100"]).toBe(-12_000);
  });

  it("excludes activity dated after the as-of date", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:august:post",
      journalDate: "2026-08-10",
      sourceType: "manual",
      lines: [
        { accountId: bank, debitMinor: 100 },
        { accountId: capital, creditMinor: 100 },
      ],
    });
    await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "manual:october:post",
      journalDate: "2026-10-10",
      sourceType: "manual",
      lines: [
        { accountId: bank, debitMinor: 900 },
        { accountId: capital, creditMinor: 900 },
      ],
    });

    const august = await ledger.trialBalance(orgId, book.id, "2026-08-31");
    expect(august.find((r) => r.code === "1020")?.balanceMinor).toBe(100);

    const october = await ledger.trialBalance(orgId, book.id, "2026-10-31");
    expect(october.find((r) => r.code === "1020")?.balanceMinor).toBe(1_000);
  });
});
