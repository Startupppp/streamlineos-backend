/**
 * Explaining an unmatched bank line — PRD 04 S2.
 *
 * A bank charge has no receipt or payment to match against. Before this, the
 * only route was "post a journal, then remember to come back and match it",
 * and the second half is the half people skip — which is how a reconciliation
 * quietly stops reconciling.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import {
  bankMatches,
  bankProfiles,
  bankStatementLines,
  bankStatements,
  glAccounts,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService } from "../kernel/sequence.service";
import { BankAccountsService } from "./bank-accounts.service";
import { MatchingService } from "./matching.service";
import { ExplainLineService } from "./explain-line.service";

const STATEMENT_START = "2026-08-01";
const STATEMENT_END = "2026-08-31";
const LINE_DATE = "2026-08-14";

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let ledger: LedgerService;
let bankAccounts: BankAccountsService;
let explainLine: ExplainLineService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

async function seedOrg(): Promise<{ orgId: string; userId: string }> {
  const orgId = `acc-exp-${crypto.randomUUID()}`;
  const userId = `acc-exp-u-${crypto.randomUUID()}`;
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

async function accountId(bookId: string, code: string): Promise<string> {
  const [row] = await db
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(and(eq(glAccounts.bookId, bookId), eq(glAccounts.code, code)))
    .limit(1);
  if (!row) throw new Error(`fixture missing account ${code}`);
  return row.id;
}

/** A book with a bank account and one statement line nothing explains. */
async function fixture(amountMinor: number, description = "Monthly account charge") {
  const { orgId, userId } = await seedOrg();
  const book = await books.enable(orgId, userId, {
    countryCode: "IN",
    packCode: "IN",
    baseCurrency: "INR",
    openFrom: LINE_DATE,
  });

  const bankGl = await accountId(book.id, "1020");
  const [profile] = await db
    .insert(bankProfiles)
    .values({
      orgId,
      bookId: book.id,
      accountId: bankGl,
      displayName: "HDFC current",
      currency: "INR",
      countryCode: "IN",
    })
    .returning({ id: bankProfiles.id });

  const [statement] = await db
    .insert(bankStatements)
    .values({
      orgId,
      bookId: book.id,
      bankProfileId: profile.id,
      source: "csv",
      periodStart: STATEMENT_START,
      periodEnd: STATEMENT_END,
      openingMinor: 0,
      closingMinor: amountMinor,
      currency: "INR",
    })
    .returning({ id: bankStatements.id });

  const [line] = await db
    .insert(bankStatementLines)
    .values({
      orgId,
      statementId: statement.id,
      lineNo: 1,
      valueDate: LINE_DATE,
      amountMinor,
      description,
    })
    .returning({ id: bankStatementLines.id });

  return { orgId, userId, book, bankGl, statementLineId: line.id };
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
  bankAccounts = new BankAccountsService(db, books);
  const matching = new MatchingService(db, bankAccounts);
  explainLine = new ExplainLineService(db, books, ledger, bankAccounts, matching);
});

afterAll(async () => {
  if (createdOrgIds.length) await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  await client?.end({ timeout: 5 });
});

describe("explaining a bank charge", () => {
  it("posts the journal and matches the line in one action", async () => {
    const f = await fixture(-1_800, "ACCOUNT MAINTENANCE FEE");

    const result = await explainLine.explain(f.orgId, f.userId, f.statementLineId, {
      contraAccountTag: "payment_fees",
    });

    expect(result.journalNumber).toMatch(/^JV\//);

    // Money left the bank, so the bank is credited and the fee debited.
    const tb = await balances(f.orgId, f.book.id);
    expect(tb["1020"]).toBe(-1_800);
    expect(tb["5910"]).toBe(1_800);
    expect(Object.values(tb).reduce((a, b) => a + b, 0)).toBe(0);

    // And the line is no longer unexplained.
    const [match] = await db
      .select()
      .from(bankMatches)
      .where(eq(bankMatches.statementLineId, f.statementLineId));
    expect(match.kind).toBe("journal");
    expect(match.journalId).toBe(result.journalId);
  });

  it("handles money arriving as well as money leaving", async () => {
    const f = await fixture(2_500, "SAVINGS INTEREST");

    await explainLine.explain(f.orgId, f.userId, f.statementLineId, {
      contraAccountTag: "other_income",
    });

    const tb = await balances(f.orgId, f.book.id);
    expect(tb["1020"]).toBe(2_500);
    expect(tb["4900"]).toBe(-2_500);
  });

  it("dates the journal to the bank's value date, not today", async () => {
    const f = await fixture(-500);
    const result = await explainLine.explain(f.orgId, f.userId, f.statementLineId, {
      contraAccountTag: "payment_fees",
    });

    const journal = await ledger.loadJournal(f.orgId, result.journalId);
    expect(journal?.journalDate).toBe(LINE_DATE);
    expect(journal?.sourceType).toBe("bank_fee");
    expect(journal?.sourceId).toBe(f.statementLineId);
  });

  it("does not post twice when the button is clicked twice", async () => {
    const f = await fixture(-1_800);

    const first = await explainLine.explain(f.orgId, f.userId, f.statementLineId, {
      contraAccountTag: "payment_fees",
    });
    // The second attempt replays the journal and then hits the 1:1 match rule,
    // which is the correct refusal — what must never happen is a second journal.
    await explainLine
      .explain(f.orgId, f.userId, f.statementLineId, { contraAccountTag: "payment_fees" })
      .catch(() => undefined);

    const tb = await balances(f.orgId, f.book.id);
    expect(tb["1020"]).toBe(-1_800);
    expect(tb["5910"]).toBe(1_800);

    const matches = await db
      .select()
      .from(bankMatches)
      .where(eq(bankMatches.statementLineId, f.statementLineId));
    expect(matches).toHaveLength(1);
    expect(matches[0].journalId).toBe(first.journalId);
  });

  it("accepts an explicit account as well as a role", async () => {
    const f = await fixture(-900);
    const rent = await accountId(f.book.id, "5310");

    await explainLine.explain(f.orgId, f.userId, f.statementLineId, {
      contraAccountId: rent,
      memo: "Standing order to the landlord",
    });

    const tb = await balances(f.orgId, f.book.id);
    expect(tb["5310"]).toBe(900);
  });

  it("refuses when no contra account is named", async () => {
    const f = await fixture(-100);
    await expect(
      explainLine.explain(f.orgId, f.userId, f.statementLineId, {}),
    ).rejects.toThrow(/which account/i);
  });

  it("leaves nothing behind when the posting is rejected", async () => {
    const f = await fixture(-1_000);
    const header = await accountId(f.book.id, "1000");

    // A header account cannot receive a posting, so the ledger refuses — and
    // the line must stay unmatched rather than being marked explained.
    await expect(
      explainLine.explain(f.orgId, f.userId, f.statementLineId, { contraAccountId: header }),
    ).rejects.toMatchObject({ code: "ACCOUNT_IS_HEADER" });

    const matches = await db
      .select()
      .from(bankMatches)
      .where(eq(bankMatches.statementLineId, f.statementLineId));
    expect(matches).toHaveLength(0);
  });
});
