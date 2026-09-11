/**
 * Opening balances — PRD 12 S1.
 *
 * The interesting behaviour is the equity plug: a founder types what they have
 * and what they owe, and the difference *is* their accumulated equity. Getting
 * that sign backwards would silently invert every balance sheet from day one,
 * so it is tested in both directions.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import {
  glAccounts,
  glJournals,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService } from "../kernel/sequence.service";
import { OpeningBalancesService } from "./opening-balances.service";

const BOOKS_OPEN_ON = "2026-04-01";

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let ledger: LedgerService;
let opening: OpeningBalancesService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

async function seedOrg(): Promise<{ orgId: string; userId: string }> {
  const orgId = `acc-ob-${crypto.randomUUID()}`;
  const userId = `acc-ob-u-${crypto.randomUUID()}`;
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
  return { orgId, userId };
}

async function freshBook() {
  const { orgId, userId } = await seedOrg();
  const book = await books.enable(orgId, userId, {
    countryCode: "IN",
    packCode: "IN",
    baseCurrency: "INR",
    // Open the prior year too, so the day before 1 April 2026 has a period.
    openFrom: "2025-06-01",
  });
  await books.ensureFiscalYear(orgId, book.id, BOOKS_OPEN_ON);
  return { orgId, userId, book };
}

async function accountId(bookId: string, code: string): Promise<string> {
  const [row] = await db
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(and(eq(glAccounts.bookId, bookId), eq(glAccounts.code, code)))
    .limit(1);
  if (!row) throw new Error(`fixture missing account ${code}`);
  return row.id;
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
  const audit = { log: () => undefined } as unknown as AuditService;
  opening = new OpeningBalancesService(db, books, ledger, audit);
});

afterAll(async () => {
  if (createdOrgIds.length) await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  await client?.end({ timeout: 5 });
});

describe("opening balances", () => {
  it("dates the journal the day before the books open", async () => {
    const { orgId, userId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await opening.post(orgId, userId, {
      asOfDate: BOOKS_OPEN_ON,
      lines: [
        { accountId: bank, amountMinor: 1_000_000 },
        { accountId: capital, amountMinor: -1_000_000 },
      ],
    });

    // 31 March, so the opening position sits outside the first real period and
    // never shows up as April movement.
    expect(posted.journalDate).toBe("2026-03-31");
    expect(posted.sourceType).toBe("opening_balance");
  });

  it("credits retained earnings when assets exceed liabilities", async () => {
    const { orgId, userId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const payable = await accountId(book.id, "2100");

    // Owns 500,000; owes 120,000. The 380,000 surplus is equity.
    await opening.post(orgId, userId, {
      asOfDate: BOOKS_OPEN_ON,
      lines: [
        { accountId: bank, amountMinor: 500_000 },
        { accountId: payable, amountMinor: -120_000 },
      ],
    });

    const tb = await balances(orgId, book.id);
    expect(tb["1020"]).toBe(500_000);
    expect(tb["2100"]).toBe(-120_000);
    expect(tb["3200"]).toBe(-380_000);
    expect(Object.values(tb).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("debits retained earnings when liabilities exceed assets", async () => {
    const { orgId, userId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const payable = await accountId(book.id, "2100");

    // A business carrying accumulated losses — the plug must go the other way.
    await opening.post(orgId, userId, {
      asOfDate: BOOKS_OPEN_ON,
      lines: [
        { accountId: bank, amountMinor: 50_000 },
        { accountId: payable, amountMinor: -200_000 },
      ],
    });

    const tb = await balances(orgId, book.id);
    expect(tb["3200"]).toBe(150_000);
    expect(Object.values(tb).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("adds no plug when the caller already balances", async () => {
    const { orgId, userId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const posted = await opening.post(orgId, userId, {
      asOfDate: BOOKS_OPEN_ON,
      lines: [
        { accountId: bank, amountMinor: 750_000 },
        { accountId: capital, amountMinor: -750_000 },
      ],
    });

    expect(posted.lines).toHaveLength(2);
    const tb = await balances(orgId, book.id);
    expect(tb["3200"] ?? 0).toBe(0);
  });

  it("previews the plug without writing anything", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const payable = await accountId(book.id, "2100");

    const preview = await opening.preview(orgId, {
      asOfDate: BOOKS_OPEN_ON,
      lines: [
        { accountId: bank, amountMinor: 500_000 },
        { accountId: payable, amountMinor: -120_000 },
      ],
    });

    expect(preview.differenceMinor).toBe(380_000);
    expect(preview.balancingAccountCode).toBe("3200");
    expect(preview.journalDate).toBe("2026-03-31");
    expect(preview.alreadyPosted).toBe(false);

    const journals = await db.select().from(glJournals).where(eq(glJournals.bookId, book.id));
    expect(journals).toHaveLength(0);
  });

  it("cannot be posted twice, which would double every balance", async () => {
    const { orgId, userId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const capital = await accountId(book.id, "3100");

    const input = {
      asOfDate: BOOKS_OPEN_ON,
      lines: [
        { accountId: bank, amountMinor: 300_000 },
        { accountId: capital, amountMinor: -300_000 },
      ],
    };

    const first = await opening.post(orgId, userId, input);
    const second = await opening.post(orgId, userId, input);

    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);

    const tb = await balances(orgId, book.id);
    expect(tb["1020"]).toBe(300_000);
    expect(await opening.isPosted(orgId, book.id)).toBe(true);
  });

  it("refuses a grouping account", async () => {
    const { orgId, userId, book } = await freshBook();
    const assetsHeader = await accountId(book.id, "1000");

    await expect(
      opening.post(orgId, userId, {
        asOfDate: BOOKS_OPEN_ON,
        lines: [{ accountId: assetsHeader, amountMinor: 1000 }],
      }),
    ).rejects.toThrow(/grouping account/i);
  });

  it("refuses an account from another book", async () => {
    const mine = await freshBook();
    const theirs = await freshBook();
    const theirBank = await accountId(theirs.book.id, "1020");

    await expect(
      opening.post(mine.orgId, mine.userId, {
        asOfDate: BOOKS_OPEN_ON,
        lines: [{ accountId: theirBank, amountMinor: 1000 }],
      }),
    ).rejects.toThrow(/not in this book/i);
  });

  it("refuses an all-zero submission rather than posting an empty journal", async () => {
    const { orgId, userId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");

    await expect(
      opening.post(orgId, userId, {
        asOfDate: BOOKS_OPEN_ON,
        lines: [{ accountId: bank, amountMinor: 0 }],
      }),
    ).rejects.toThrow(/zero/i);
  });
});
