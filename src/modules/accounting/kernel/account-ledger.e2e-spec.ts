/**
 * Account ledger — PRD 09 §L, "drill to source".
 *
 * A report figure is only auditable if a reader can walk from it to the
 * entries behind it and on to the document that caused each one. The two ways
 * that quietly breaks are a running balance recomputed per page (so page two
 * restarts at zero and disagrees with the report) and a source pointer the
 * endpoint forgets to carry (so the trail stops at the journal). Both are
 * pinned here, against a real Postgres, because the running balance is a window
 * function and a mock would not have one.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import * as schema from "../../../db/schema";
import {
  glAccounts,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PackRegistry } from "../packs/pack.registry";
import { AccountsService } from "./accounts.service";
import { BooksService } from "./books.service";
import { LedgerService } from "./ledger.service";
import { SequenceService } from "./sequence.service";
import { addDays } from "./fiscal-calendar";

const PRIOR_FY_START = "2025-04-01";
const BROUGHT_FORWARD_DATE = "2026-03-31";
const WINDOW_FROM = "2026-04-01";
const WINDOW_TO = "2026-04-30";

/** Paise. 5,000.00 INR carried into the window. */
const BROUGHT_FORWARD = 500_000;
const ENTRY_COUNT = 25;
const PAGE_SIZE = 10;

/** `n`th daily posting: 100, 200, 300 … paise, so every partial sum is distinct. */
function amountFor(n: number): number {
  return n * 100;
}

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let ledger: LedgerService;
let accounts: AccountsService;
let fixture: Fixture;

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
    // The prior year too, so 31 March 2026 has a period to post into.
    openFrom: PRIOR_FY_START,
  });
  await books.ensureFiscalYear(orgId, book.id, WINDOW_FROM);
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

interface Fixture {
  orgId: string;
  userId: string;
  bookId: string;
  bankId: string;
  invoiceJournalId: string;
}

/**
 * Cash brought forward, then a posting a day for 25 days, then one sales
 * invoice on the last day so the source pointer has something to point at.
 */
async function seedLedger(): Promise<Fixture> {
  const { orgId, userId, book } = await freshBook();
  const bankId = await accountId(book.id, "1020");
  const capitalId = await accountId(book.id, "3100");
  const salesId = await accountId(book.id, "4100");

  await ledger.post(orgId, userId, {
    bookId: book.id,
    idempotencyKey: `opening_balance:${book.id}:post`,
    journalDate: BROUGHT_FORWARD_DATE,
    memo: "Opening cash",
    sourceType: "opening_balance",
    lines: [
      { accountId: bankId, debitMinor: BROUGHT_FORWARD },
      { accountId: capitalId, creditMinor: BROUGHT_FORWARD },
    ],
  });

  for (let n = 1; n <= ENTRY_COUNT; n += 1) {
    await ledger.post(orgId, userId, {
      bookId: book.id,
      idempotencyKey: `seed:${book.id}:day-${n}`,
      journalDate: addDays(WINDOW_FROM, n - 1),
      memo: `Day ${n} takings`,
      sourceType: "manual",
      lines: [
        { accountId: bankId, debitMinor: amountFor(n), description: `Takings for day ${n}` },
        { accountId: salesId, creditMinor: amountFor(n) },
      ],
    });
  }

  const invoice = await ledger.post(orgId, userId, {
    bookId: book.id,
    idempotencyKey: `seed:${book.id}:invoice`,
    journalDate: WINDOW_TO,
    memo: "INV-0001",
    sourceType: "sales_invoice",
    sourceId: "ar-doc-0001",
    lines: [
      { accountId: bankId, debitMinor: 25_000, description: "Settled on issue" },
      { accountId: salesId, creditMinor: 25_000 },
    ],
  });

  return { orgId, userId, bookId: book.id, bankId, invoiceJournalId: invoice.id };
}

function read(page: number, pageSize = PAGE_SIZE) {
  return accounts.ledger(fixture.orgId, fixture.bookId, fixture.bankId, {
    from: WINDOW_FROM,
    to: WINDOW_TO,
    page,
    pageSize,
  });
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
  accounts = new AccountsService(db, new AuditService(db));

  // Seeded once: every test here reads, none writes, and posting 27 journals
  // per test would make the suite twenty times slower for no extra proof.
  fixture = await seedLedger();
});

afterAll(async () => {
  if (createdOrgIds.length) await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  await client?.end({ timeout: 5 });
});

describe("account ledger", () => {
  it("returns the window in ledger order, with what was carried into it kept separate", async () => {
    const first = await read(1);

    expect(first.total).toBe(ENTRY_COUNT + 1);
    expect(first.entries).toHaveLength(PAGE_SIZE);
    expect(first.opening.balanceMinor).toBe(BROUGHT_FORWARD);

    // The brought-forward journal is dated before the window, so it belongs in
    // `opening` and must not appear as an entry.
    expect(first.entries.some((e) => e.journalDate === BROUGHT_FORWARD_DATE)).toBe(false);

    const dates = first.entries.map((e) => e.journalDate);
    expect([...dates].sort()).toEqual(dates);
    const numbers = first.entries.map((e) => e.journalNumber);
    expect([...numbers].sort()).toEqual(numbers);

    expect(first.entries[0]!.journalDate).toBe(WINDOW_FROM);
    expect(first.entries[0]!.debitMinor).toBe(amountFor(1));
    expect(first.entries[0]!.description).toBe("Takings for day 1");
    expect(first.entries[0]!.memo).toBe("Day 1 takings");
  });

  it("carries the running balance across a page boundary", async () => {
    const first = await read(1);
    const second = await read(2);

    // Row one starts from what was carried in, not from zero.
    expect(first.entries[0]!.runningBalanceMinor).toBe(BROUGHT_FORWARD + amountFor(1));

    let expected = BROUGHT_FORWARD;
    for (const entry of first.entries) {
      expected += entry.debitMinor - entry.creditMinor;
      expect(entry.runningBalanceMinor).toBe(expected);
    }

    // The join between the pages: page two continues, it does not restart.
    const lastOfFirst = first.entries.at(-1)!;
    const firstOfSecond = second.entries[0]!;
    expect(firstOfSecond.journalNumber > lastOfFirst.journalNumber).toBe(true);
    expect(firstOfSecond.runningBalanceMinor).toBe(
      lastOfFirst.runningBalanceMinor + firstOfSecond.debitMinor - firstOfSecond.creditMinor,
    );

    // Which is the same as it would be with no paging at all.
    expect(firstOfSecond.runningBalanceMinor).toBe(
      BROUGHT_FORWARD +
        Array.from({ length: PAGE_SIZE + 1 }, (_, i) => amountFor(i + 1)).reduce((a, b) => a + b, 0),
    );

    for (const entry of second.entries) {
      expected += entry.debitMinor - entry.creditMinor;
      expect(entry.runningBalanceMinor).toBe(expected);
    }
  });

  it("closes where the last page's last row does", async () => {
    const first = await read(1);
    const last = await read(Math.ceil((ENTRY_COUNT + 1) / PAGE_SIZE));

    const movement = Array.from({ length: ENTRY_COUNT }, (_, i) => amountFor(i + 1)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(first.periodDebitMinor).toBe(movement + 25_000);
    expect(first.periodCreditMinor).toBe(0);
    expect(first.closingBalanceMinor).toBe(BROUGHT_FORWARD + movement + 25_000);
    expect(last.entries.at(-1)!.runningBalanceMinor).toBe(first.closingBalanceMinor);
  });

  it("carries the source document so a reader can open what caused the entry", async () => {
    const last = await read(Math.ceil((ENTRY_COUNT + 1) / PAGE_SIZE));

    const entry = last.entries.at(-1)!;
    expect(entry.sourceType).toBe("sales_invoice");
    expect(entry.sourceId).toBe("ar-doc-0001");
    expect(entry.journalId).toBe(fixture.invoiceJournalId);

    // A manual journal has no document behind it, and says so rather than
    // pointing somewhere wrong.
    const first = await read(1);
    expect(first.entries[0]!.sourceType).toBe("manual");
    expect(first.entries[0]!.sourceId).toBeNull();
  });

  it("caps the page size at 100 however large a page is asked for", async () => {
    const page = await read(1, 500);

    expect(page.pageSize).toBe(100);
    expect(page.entries).toHaveLength(ENTRY_COUNT + 1);
  });

  it("reports an account in another tenant as missing, never as forbidden", async () => {
    const theirs = await freshBook();
    const theirBank = await accountId(theirs.book.id, "1020");

    await expect(
      accounts.ledger(fixture.orgId, fixture.bookId, theirBank, {
        from: WINDOW_FROM,
        to: WINDOW_TO,
        page: 1,
        pageSize: PAGE_SIZE,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses a window that ends before it starts", async () => {
    await expect(
      accounts.ledger(fixture.orgId, fixture.bookId, fixture.bankId, {
        from: WINDOW_TO,
        to: WINDOW_FROM,
        page: 1,
        pageSize: PAGE_SIZE,
      }),
    ).rejects.toThrow(/ends before it starts/i);
  });
});
