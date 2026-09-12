/**
 * Banking and reconciliation acceptance suite — the hard gate from
 * `04-prd-banking.md`.
 *
 * Runs against a real Postgres: half of what is being proven (the partial
 * unique that makes a match 1:1, the unique that makes a re-import a 409, the
 * `amount_minor <> 0` check) does not exist in a mock.
 *
 * Services are constructed with `new` rather than through Nest DI — the same
 * pattern as `ledger.e2e-spec.ts`. Receipts and payments are inserted directly
 * with drizzle because AR and AP are being built in parallel; banking only ever
 * *references* those tables, and this suite proves it can do so without them.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import { glBookCurrencies } from "../../../db/schema";
import {
  apPayments,
  arReceipts,
  bankStatementLines,
  bankStatements,
  glAccounts,
  glParties,
  glPeriods,
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
import { StatementImportService } from "./statement-import.service";
import { MatchingService } from "./matching.service";
import { ReconciliationService } from "./reconciliation.service";
import { parseAmountToMinor, parseStatementDate, StatementCsvError } from "./statement-csv";
import { STATEMENT_MAPPING_PRESETS } from "./csv-presets";

const USER_ID = null;

/** The statement window every scenario uses, inside FY 2026-27. */
const PERIOD_START = "2026-04-01";
const PERIOD_END = "2026-04-30";
/** Deliberately in the *previous* fiscal year: an opening balance is carried in. */
const OPENING_DATE = "2026-03-31";

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let ledger: LedgerService;
let bankAccounts: BankAccountsService;
let statements: StatementImportService;
let matching: MatchingService;
let reconciliation: ReconciliationService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * Create a tenant the way the platform really does — `organizations` and
 * `organization_members` reference each other, and the constraint is DEFERRABLE
 * precisely so both rows can be written inside one transaction.
 */
async function seedOrg(): Promise<string> {
  const orgId = `acc-test-${crypto.randomUUID()}`;
  const userId = `acc-user-${crypto.randomUUID()}`;
  createdOrgIds.push(orgId);
  createdUserIds.push(userId);

  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id: userId, email: `${userId}@accounting.test` }).onConflictDoNothing();
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

/** A fresh org with accounting enabled and both relevant fiscal years open. */
async function freshBook() {
  const orgId = await seedOrg();
  const book = await books.enable(orgId, USER_ID, {
    countryCode: "IN",
    packCode: "IN",
    baseCurrency: "INR",
    openFrom: PERIOD_START,
  });
  // The opening balance is dated in FY 2025-26, so that year needs periods too.
  await books.ensureFiscalYear(orgId, book.id, OPENING_DATE);
  return { orgId, book };
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

/** A second cash account the base chart does not ship — the USD bank (M7). */
async function addUsdBankAccount(orgId: string, bookId: string): Promise<string> {
  const parent = await accountId(bookId, "1000");
  const [row] = await db
    .insert(glAccounts)
    .values({
      orgId,
      bookId,
      code: "1021",
      name: "USD bank account",
      accountType: "ASSET",
      parentAccountId: parent,
      isCash: true,
      currencyRestriction: "USD",
    })
    .returning({ id: glAccounts.id });
  if (!row) throw new Error("Could not create the USD bank account");
  return row.id;
}

async function addParty(orgId: string, bookId: string, displayName: string): Promise<string> {
  const [row] = await db
    .insert(glParties)
    .values({
      orgId,
      bookId,
      role: "both",
      displayName,
      countryCode: "IN",
      defaultCurrency: "INR",
    })
    .returning({ id: glParties.id });
  if (!row) throw new Error("Could not create the party");
  return row.id;
}

interface CashFixture {
  orgId: string;
  bookId: string;
  bankAccountId: string;
  bankProfileId: string;
  partyId: string;
}

/**
 * The scenario every acceptance test starts from: 10,000.00 of cash carried
 * into April by an opening journal, and a bank account attached to it.
 */
async function seedCashBook(openingMinor = 1_000_000): Promise<CashFixture> {
  const { orgId, book } = await freshBook();
  const bank = await accountId(book.id, "1020");
  const capital = await accountId(book.id, "3100");

  await ledger.post(orgId, USER_ID, {
    bookId: book.id,
    idempotencyKey: `opening_balance:${book.id}:post`,
    journalDate: OPENING_DATE,
    memo: "Opening cash",
    sourceType: "opening_balance",
    lines: [
      { accountId: bank, debitMinor: openingMinor },
      { accountId: capital, creditMinor: openingMinor },
    ],
  });

  const profile = await bankAccounts.create(orgId, USER_ID, {
    accountId: bank,
    displayName: "Primary current account",
    bankName: "Test Bank",
    countryCode: "IN",
    identifierScheme: "IFSC_ACCOUNT",
    identifierValue: "000123456789",
    branchIdentifier: "TEST0000001",
    csvMappingPreset: "US_QBO_THREE_COLUMN",
  });

  return {
    orgId,
    bookId: book.id,
    bankAccountId: bank,
    bankProfileId: profile.id,
    partyId: await addParty(orgId, book.id, "Acme Corp"),
  };
}

/** A receipt row, written straight to the table — AR's service may not exist yet. */
async function insertReceipt(
  fixture: CashFixture,
  input: {
    date: string;
    amountMinor: number;
    currency?: string;
    depositAccountId?: string;
    postedJournalId?: string;
    reference?: string;
    receiptNumber?: string;
    fxRate?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(arReceipts)
    .values({
      orgId: fixture.orgId,
      bookId: fixture.bookId,
      partyId: fixture.partyId,
      receiptNumber: input.receiptNumber ?? `RCP-${crypto.randomUUID().slice(0, 8)}`,
      receiptDate: input.date,
      depositAccountId: input.depositAccountId ?? fixture.bankAccountId,
      currency: input.currency ?? "INR",
      fxRate: input.fxRate ?? "1",
      amountMinor: input.amountMinor,
      status: "POSTED",
      reference: input.reference ?? null,
      postedJournalId: input.postedJournalId ?? null,
    })
    .returning({ id: arReceipts.id });
  if (!row) throw new Error("Could not insert the receipt");
  return row.id;
}

async function insertPayment(
  fixture: CashFixture,
  input: {
    date: string;
    netPaidMinor: number;
    currency?: string;
    paymentAccountId?: string;
    postedJournalId?: string;
    reference?: string;
    fxRate?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(apPayments)
    .values({
      orgId: fixture.orgId,
      bookId: fixture.bookId,
      partyId: fixture.partyId,
      paymentNumber: `PAY-${crypto.randomUUID().slice(0, 8)}`,
      paymentDate: input.date,
      paymentAccountId: input.paymentAccountId ?? fixture.bankAccountId,
      currency: input.currency ?? "INR",
      fxRate: input.fxRate ?? "1",
      grossMinor: input.netPaidMinor,
      withheldMinor: 0,
      netPaidMinor: input.netPaidMinor,
      status: "POSTED",
      reference: input.reference ?? null,
      postedJournalId: input.postedJournalId ?? null,
    })
    .returning({ id: apPayments.id });
  if (!row) throw new Error("Could not insert the payment");
  return row.id;
}

/** `Date,Description,Reference,Amount` — the US/QBO preset's shape. */
function qboCsv(rows: Array<[string, string, string, string]>): string {
  return ["Date,Description,Reference,Amount", ...rows.map((r) => r.join(","))].join("\n");
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for the banking acceptance suite");
  client = postgres(url, { prepare: false, max: 5 });
  db = drizzle(client, { schema }) as unknown as Db;

  const packs = new PackRegistry();
  const sequences = new SequenceService(db);
  books = new BooksService(db, packs);
  ledger = new LedgerService(db, sequences, packs);
  bankAccounts = new BankAccountsService(db, books);
  statements = new StatementImportService(db, bankAccounts);
  matching = new MatchingService(db, bankAccounts);
  reconciliation = new ReconciliationService(db, books, bankAccounts, statements, matching);
});

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await client?.end({ timeout: 5 });
});

/* ------------------------------------------------------- bank account setup */

describe("a bank account is a GL account", () => {
  it("attaches a profile to a cash account and derives the balance from the ledger", async () => {
    const fixture = await seedCashBook();

    const profile = await bankAccounts.get(fixture.orgId, fixture.bankProfileId);
    expect(profile.accountCode).toBe("1020");
    expect(profile.currency).toBe("INR");
    expect(profile.csvMapping?.dateFormat).toBe("MM/DD/YYYY");

    // No balance column exists anywhere; this number is a sum over journal lines.
    const balance = await bankAccounts.balance(fixture.orgId, fixture.bankProfileId, PERIOD_END);
    expect(balance.balanceMinor).toBe(1_000_000);
    expect(balance.functionalBalanceMinor).toBe(1_000_000);
    expect(balance.functionalCurrency).toBe("INR");

    // …and it is date-bounded.
    const before = await bankAccounts.glBalanceMinor(fixture.bookId, fixture.bankAccountId, "2026-03-30");
    expect(before).toBe(0);
  });

  it("refuses a non-cash account and refuses a header account", async () => {
    const { orgId, book } = await freshBook();
    const arControl = await accountId(book.id, "1100");
    const header = await accountId(book.id, "1000");

    await expect(
      bankAccounts.create(orgId, USER_ID, {
        accountId: arControl,
        displayName: "Not a bank",
        countryCode: "IN",
      }),
    ).rejects.toThrow(/not a cash account/i);

    await expect(
      bankAccounts.create(orgId, USER_ID, {
        accountId: header,
        displayName: "Also not a bank",
        countryCode: "IN",
      }),
    ).rejects.toThrow(/header account/i);
  });

  it("refuses a second profile on the same GL account, and saves a CSV mapping", async () => {
    const fixture = await seedCashBook();

    await expect(
      bankAccounts.create(fixture.orgId, USER_ID, {
        accountId: fixture.bankAccountId,
        displayName: "Duplicate",
        countryCode: "IN",
      }),
    ).rejects.toThrow(/already has a bank account/i);

    const updated = await bankAccounts.saveCsvMapping(fixture.orgId, fixture.bankProfileId, {
      preset: "IN_NARRATION_WITHDRAWAL_DEPOSIT",
    });
    expect(updated.csvMapping?.dateFormat).toBe("DD/MM/YYYY");
    expect(updated.csvMapping?.debitColumn).toBe("Withdrawal Amt.");

    const renamed = await bankAccounts.update(fixture.orgId, USER_ID, fixture.bankProfileId, {
      displayName: "Renamed account",
    });
    expect(renamed.displayName).toBe("Renamed account");
  });

  it("returns 404, never 403, for another tenant's bank account", async () => {
    const mine = await seedCashBook();
    const theirs = await seedCashBook();
    await expect(bankAccounts.get(theirs.orgId, mine.bankProfileId)).rejects.toThrow(/not found/i);
  });
});

/* ------------------------------------------------------------ acceptance 1 */

describe("1 — opening cash, two matched movements, the rec proof holds", () => {
  it("ties the books to the bank with nothing outstanding", async () => {
    const fixture = await seedCashBook();

    const receiptJournal = await ledger.post(fixture.orgId, USER_ID, {
      bookId: fixture.bookId,
      idempotencyKey: "receipt:acceptance-1:post",
      journalDate: "2026-04-05",
      sourceType: "receipt",
      memo: "Acme invoice settled",
      lines: [
        { accountId: fixture.bankAccountId, debitMinor: 50_000 },
        { accountId: await accountId(fixture.bookId, "1100"), creditMinor: 50_000 },
      ],
    });
    const receiptId = await insertReceipt(fixture, {
      date: "2026-04-05",
      amountMinor: 50_000,
      postedJournalId: receiptJournal.id,
      reference: "UTR9911",
    });

    const paymentJournal = await ledger.post(fixture.orgId, USER_ID, {
      bookId: fixture.bookId,
      idempotencyKey: "payment:acceptance-1:post",
      journalDate: "2026-04-12",
      sourceType: "payment",
      memo: "Vendor paid",
      lines: [
        { accountId: await accountId(fixture.bookId, "2100"), debitMinor: 20_000 },
        { accountId: fixture.bankAccountId, creditMinor: 20_000 },
      ],
    });
    const paymentId = await insertPayment(fixture, {
      date: "2026-04-12",
      netPaidMinor: 20_000,
      postedJournalId: paymentJournal.id,
      reference: "NEFT4477",
    });

    const imported = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      fileName: "april.csv",
      content: qboCsv([
        ["04/05/2026", "ACME CORP UPI CREDIT", "UTR9911", "500.00"],
        ["04/12/2026", "NEFT DR VENDOR", "NEFT4477", "-200.00"],
      ]),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "10300.00",
    });

    expect(imported.lineCount).toBe(2);
    expect(imported.movementMinor).toBe(30_000);
    expect(imported.warnings).toHaveLength(0);
    expect(imported.lines.map((l) => l.amountMinor)).toEqual([50_000, -20_000]);

    await matching.match(fixture.orgId, USER_ID, imported.lines[0].id, {
      kind: "receipt",
      id: receiptId,
    });
    await matching.match(fixture.orgId, USER_ID, imported.lines[1].id, {
      kind: "payment",
      id: paymentId,
    });

    const proof = await reconciliation.getRecProof(fixture.orgId, imported.statementId);

    expect(proof.currency).toBe("INR");
    expect(proof.glBalanceMinor).toBe(1_030_000); // G
    expect(proof.statementClosingMinor).toBe(1_030_000); // S
    expect(proof.unmatchedGlMinor).toBe(0); // Ugl
    expect(proof.unmatchedStatementMinor).toBe(0); // Ust
    expect(proof.adjustedGlMinor).toBe(proof.adjustedStatementMinor);
    expect(proof.differenceMinor).toBe(0);
    expect(proof.holds).toBe(true);
    expect(proof.openingVarianceMinor).toBe(0);

    const marked = await reconciliation.markReconciled(fixture.orgId, USER_ID, imported.statementId);
    expect(marked.reconciledAt).toBeInstanceOf(Date);
  });
});

/* ------------------------------------------------------------ acceptance 2 */

describe("2 — an unmatched bank fee shows up, then is booked and matched", () => {
  it("names the fee as the whole difference, then closes it out", async () => {
    const fixture = await seedCashBook();

    const receiptJournal = await ledger.post(fixture.orgId, USER_ID, {
      bookId: fixture.bookId,
      idempotencyKey: "receipt:acceptance-2:post",
      journalDate: "2026-04-05",
      sourceType: "receipt",
      lines: [
        { accountId: fixture.bankAccountId, debitMinor: 50_000 },
        { accountId: await accountId(fixture.bookId, "1100"), creditMinor: 50_000 },
      ],
    });
    const receiptId = await insertReceipt(fixture, {
      date: "2026-04-05",
      amountMinor: 50_000,
      postedJournalId: receiptJournal.id,
    });

    const paymentJournal = await ledger.post(fixture.orgId, USER_ID, {
      bookId: fixture.bookId,
      idempotencyKey: "payment:acceptance-2:post",
      journalDate: "2026-04-12",
      sourceType: "payment",
      lines: [
        { accountId: await accountId(fixture.bookId, "2100"), debitMinor: 20_000 },
        { accountId: fixture.bankAccountId, creditMinor: 20_000 },
      ],
    });
    const paymentId = await insertPayment(fixture, {
      date: "2026-04-12",
      netPaidMinor: 20_000,
      postedJournalId: paymentJournal.id,
    });

    const imported = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      fileName: "april-with-fee.csv",
      content: qboCsv([
        ["04/05/2026", "ACME CORP UPI CREDIT", "UTR9911", "500.00"],
        ["04/12/2026", "NEFT DR VENDOR", "NEFT4477", "-200.00"],
        ["04/30/2026", "MONTHLY ACCOUNT MAINTENANCE FEE", "FEE0430", "-18.00"],
      ]),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "10282.00",
    });

    await matching.match(fixture.orgId, USER_ID, imported.lines[0].id, { kind: "receipt", id: receiptId });
    await matching.match(fixture.orgId, USER_ID, imported.lines[1].id, { kind: "payment", id: paymentId });

    /* The fee is on the bank side and nowhere in the books. */
    const unreconciled = await matching.listUnreconciled(fixture.orgId, {
      bookId: fixture.bookId,
      accountId: fixture.bankAccountId,
      asOf: PERIOD_END,
    });
    expect(unreconciled.statementLines).toHaveLength(1);
    expect(unreconciled.statementLines[0].amountMinor).toBe(-1_800);
    expect(unreconciled.statementLinesTotalMinor).toBe(-1_800);
    // The opening journal is carried in by the statement's opening balance, so
    // it is not an outstanding item for this window.
    expect(unreconciled.glLines.map((l) => l.amountMinor)).toEqual([1_000_000]);

    const before = await reconciliation.getRecProof(fixture.orgId, imported.statementId);
    expect(before.glBalanceMinor).toBe(1_030_000);
    expect(before.statementClosingMinor).toBe(1_028_200);
    // Books and bank differ by exactly the fee, and the proof says so.
    expect(before.glBalanceMinor - before.statementClosingMinor).toBe(1_800);
    expect(before.unmatchedStatementMinor).toBe(-1_800);
    expect(before.holds).toBe(true);
    expect(before.explanation).toMatch(/bank movement\(s\) the books have not recorded/);

    /* Book the fee, match it, and the difference disappears entirely. */
    const feeJournal = await ledger.post(fixture.orgId, USER_ID, {
      bookId: fixture.bookId,
      idempotencyKey: "bank_fee:acceptance-2:post",
      journalDate: "2026-04-30",
      sourceType: "bank_fee",
      memo: "Monthly account maintenance",
      lines: [
        { accountId: await accountId(fixture.bookId, "5910"), debitMinor: 1_800 },
        { accountId: fixture.bankAccountId, creditMinor: 1_800 },
      ],
    });

    await matching.match(fixture.orgId, USER_ID, imported.lines[2].id, {
      kind: "journal",
      id: feeJournal.id,
    });

    const after = await reconciliation.getRecProof(fixture.orgId, imported.statementId);
    expect(after.glBalanceMinor).toBe(1_028_200);
    expect(after.statementClosingMinor).toBe(1_028_200);
    expect(after.unmatchedGlMinor).toBe(0);
    expect(after.unmatchedStatementMinor).toBe(0);
    expect(after.unmatchedStatementLines).toHaveLength(0);
    expect(after.holds).toBe(true);
    expect(after.explanation).toMatch(/nothing outstanding/);

    const stillUnreconciled = await matching.listUnreconciled(fixture.orgId, {
      accountId: fixture.bankAccountId,
      asOf: PERIOD_END,
    });
    expect(stillUnreconciled.statementLines).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ acceptance 3 */

describe("3 — the same file cannot be imported twice", () => {
  it("rejects a re-import on the file hash and leaves the lines alone", async () => {
    const fixture = await seedCashBook();
    const content = qboCsv([
      ["04/05/2026", "ACME CORP UPI CREDIT", "UTR9911", "500.00"],
      ["04/12/2026", "NEFT DR VENDOR", "NEFT4477", "-200.00"],
    ]);

    const first = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      fileName: "april.csv",
      content,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "10300.00",
    });
    expect(first.fileHash).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      statements.import(fixture.orgId, USER_ID, {
        bankProfileId: fixture.bankProfileId,
        fileName: "april (1).csv",
        content,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        opening: "10000.00",
        closing: "10300.00",
      }),
    ).rejects.toThrow(/already imported/i);

    const rows = await db
      .select({ id: bankStatements.id })
      .from(bankStatements)
      .where(eq(bankStatements.bankProfileId, fixture.bankProfileId));
    expect(rows).toHaveLength(1);

    const lines = await db
      .select({ id: bankStatementLines.id })
      .from(bankStatementLines)
      .where(eq(bankStatementLines.statementId, first.statementId));
    expect(lines).toHaveLength(2);
  });

  it("still allows a genuinely different file for the same period", async () => {
    const fixture = await seedCashBook();
    const base = {
      bankProfileId: fixture.bankProfileId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "10300.00",
    };

    await statements.import(fixture.orgId, USER_ID, {
      ...base,
      content: qboCsv([
        ["04/05/2026", "ACME CORP UPI CREDIT", "UTR9911", "500.00"],
        ["04/12/2026", "NEFT DR VENDOR", "NEFT4477", "-200.00"],
      ]),
    });

    const second = await statements.import(fixture.orgId, USER_ID, {
      ...base,
      content: qboCsv([
        ["04/06/2026", "ACME CORP UPI CREDIT", "UTR9912", "500.00"],
        ["04/13/2026", "NEFT DR VENDOR", "NEFT4478", "-200.00"],
      ]),
    });
    expect(second.lineCount).toBe(2);
  });
});

/* ------------------------------------------------------------ acceptance 4 */

describe("4 — a match with the wrong amount is refused", () => {
  it("refuses a counterpart whose amount differs, and keeps 1:1 strictly", async () => {
    const fixture = await seedCashBook();

    const imported = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      content: qboCsv([
        ["04/05/2026", "ACME CORP UPI CREDIT", "UTR9911", "500.00"],
        ["04/06/2026", "ACME CORP UPI CREDIT", "UTR9912", "500.00"],
      ]),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "11000.00",
    });

    const wrongAmount = await insertReceipt(fixture, { date: "2026-04-05", amountMinor: 60_000 });
    await expect(
      matching.match(fixture.orgId, USER_ID, imported.lines[0].id, {
        kind: "receipt",
        id: wrongAmount,
      }),
    ).rejects.toThrow(/Amounts do not match/i);

    // …and nothing was recorded by the failed attempt.
    const rightAmount = await insertReceipt(fixture, { date: "2026-04-05", amountMinor: 50_000 });
    const recorded = await matching.match(fixture.orgId, USER_ID, imported.lines[0].id, {
      kind: "receipt",
      id: rightAmount,
    });
    expect(recorded.amountMinor).toBe(50_000);

    // One bank line explains one thing…
    const another = await insertReceipt(fixture, { date: "2026-04-05", amountMinor: 50_000 });
    await expect(
      matching.match(fixture.orgId, USER_ID, imported.lines[0].id, { kind: "receipt", id: another }),
    ).rejects.toThrow(/already matched/i);

    // …and one receipt explains one bank line.
    await expect(
      matching.match(fixture.orgId, USER_ID, imported.lines[1].id, { kind: "receipt", id: rightAmount }),
    ).rejects.toThrow(/already matched to a different bank line/i);
  });

  it("refuses a counterpart in the wrong currency and one on the wrong account", async () => {
    const fixture = await seedCashBook();
    const usdAccount = await addUsdBankAccount(fixture.orgId, fixture.bookId);

    const imported = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      content: qboCsv([["04/05/2026", "CREDIT", "UTR1", "500.00"]]),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "10500.00",
    });

    const wrongCurrency = await insertReceipt(fixture, {
      date: "2026-04-05",
      amountMinor: 50_000,
      currency: "USD",
      fxRate: "83",
    });
    await expect(
      matching.match(fixture.orgId, USER_ID, imported.lines[0].id, {
        kind: "receipt",
        id: wrongCurrency,
      }),
    ).rejects.toThrow(/reconciliation compares in the bank account's currency/i);

    const wrongAccount = await insertReceipt(fixture, {
      date: "2026-04-05",
      amountMinor: 50_000,
      depositAccountId: usdAccount,
    });
    await expect(
      matching.match(fixture.orgId, USER_ID, imported.lines[0].id, {
        kind: "receipt",
        id: wrongAccount,
      }),
    ).rejects.toThrow(/moved a different GL account/i);
  });
});

/* ------------------------------------------------------------ acceptance 5 */

describe("5 — a USD bank account on INR books reconciles in USD", () => {
  it("compares the statement against the transaction currency, not the functional one", async () => {
    const { orgId, book } = await freshBook();
    // The book only trades in currencies it has enabled (PRD 11 M4).
    await db
      .insert(glBookCurrencies)
      .values({ orgId, bookId: book.id, currencyCode: "USD", isBase: false })
      .onConflictDoNothing();
    const usdAccount = await addUsdBankAccount(orgId, book.id);
    const capital = await accountId(book.id, "3100");
    const arControl = await accountId(book.id, "1100");
    const apControl = await accountId(book.id, "2100");

    const profile = await bankAccounts.create(orgId, USER_ID, {
      accountId: usdAccount,
      displayName: "Mercury USD",
      currency: "USD",
      countryCode: "US",
      csvMappingPreset: "WISE_MERCURY_SIGNED",
    });
    expect(profile.currency).toBe("USD");

    const fixture: CashFixture = {
      orgId,
      bookId: book.id,
      bankAccountId: usdAccount,
      bankProfileId: profile.id,
      partyId: await addParty(orgId, book.id, "US Customer"),
    };

    // $10,000.00 at 83.00 = ₹830,000.00 carried in.
    await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "opening_balance:usd:post",
      journalDate: OPENING_DATE,
      sourceType: "opening_balance",
      lines: [
        {
          accountId: usdAccount,
          debitMinor: 83_000_000,
          txnCurrency: "USD",
          txnAmountMinor: 1_000_000,
          fxRate: "83",
        },
        { accountId: capital, creditMinor: 83_000_000 },
      ],
    });

    // $2,000.00 in at 83.50, $500.00 out at 84.00 — three different rates.
    const receiptJournal = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "receipt:usd:post",
      journalDate: "2026-04-05",
      sourceType: "receipt",
      lines: [
        {
          accountId: usdAccount,
          debitMinor: 16_700_000,
          txnCurrency: "USD",
          txnAmountMinor: 200_000,
          fxRate: "83.5",
        },
        { accountId: arControl, creditMinor: 16_700_000 },
      ],
    });
    const receiptId = await insertReceipt(fixture, {
      date: "2026-04-05",
      amountMinor: 200_000,
      currency: "USD",
      fxRate: "83.5",
      postedJournalId: receiptJournal.id,
    });

    const paymentJournal = await ledger.post(orgId, USER_ID, {
      bookId: book.id,
      idempotencyKey: "payment:usd:post",
      journalDate: "2026-04-12",
      sourceType: "payment",
      lines: [
        { accountId: apControl, debitMinor: 4_200_000 },
        {
          accountId: usdAccount,
          creditMinor: 4_200_000,
          txnCurrency: "USD",
          txnAmountMinor: 50_000,
          fxRate: "84",
        },
      ],
    });
    const paymentId = await insertPayment(fixture, {
      date: "2026-04-12",
      netPaidMinor: 50_000,
      currency: "USD",
      fxRate: "84",
      postedJournalId: paymentJournal.id,
    });

    const imported = await statements.import(orgId, USER_ID, {
      bankProfileId: profile.id,
      fileName: "mercury-april.csv",
      content: [
        "Date,Description,Payment Reference,Amount",
        "2026-04-05,Incoming wire US Customer,W-88231,2000.00",
        "2026-04-12,Outgoing wire supplier,W-88250,-500.00",
      ].join("\n"),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "11500.00",
    });
    expect(imported.currency).toBe("USD");

    await matching.match(orgId, USER_ID, imported.lines[0].id, { kind: "receipt", id: receiptId });
    await matching.match(orgId, USER_ID, imported.lines[1].id, { kind: "payment", id: paymentId });

    const proof = await reconciliation.getRecProof(orgId, imported.statementId);

    expect(proof.currency).toBe("USD");
    expect(proof.glBalanceMinor).toBe(1_150_000); // $11,500.00
    expect(proof.statementClosingMinor).toBe(1_150_000);
    expect(proof.holds).toBe(true);

    // The functional balance is a completely different number — and comparing
    // *it* to the statement would be wrong by ₹94,350.00.
    expect(proof.functionalCurrency).toBe("INR");
    expect(proof.glBalanceFunctionalMinor).toBe(95_500_000);
    expect(proof.glBalanceFunctionalMinor).not.toBe(proof.statementClosingMinor);

    const balance = await bankAccounts.balance(orgId, profile.id, PERIOD_END);
    expect(balance.currency).toBe("USD");
    expect(balance.balanceMinor).toBe(1_150_000);
    expect(balance.functionalBalanceMinor).toBe(95_500_000);
  });
});

/* --------------------------------------------------- CSV date-format proof */

describe("CSV date handling — DD/MM vs MM/DD is declared, never guessed", () => {
  it("reads 03/04/2026 as 3 April under DD/MM and 4 March under MM/DD", () => {
    expect(parseStatementDate("03/04/2026", "DD/MM/YYYY")).toBe("2026-04-03");
    expect(parseStatementDate("03/04/2026", "MM/DD/YYYY")).toBe("2026-03-04");
  });

  it("proves both readings end to end, through a real import", async () => {
    const fixture = await seedCashBook();

    const dayFirst = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      fileName: "day-first.csv",
      content: ["Date,Description,Reference,Amount", "03/04/2026,DAY FIRST ROW,REF-A,100.00"].join("\n"),
      mapping: { dateFormat: "DD/MM/YYYY" },
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      opening: "0.00",
      closing: "100.00",
    });
    expect(dayFirst.lines[0].valueDate).toBe("2026-04-03");

    const monthFirst = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      fileName: "month-first.csv",
      content: ["Date,Description,Reference,Amount", "03/04/2026,MONTH FIRST ROW,REF-B,100.00"].join("\n"),
      mapping: { dateFormat: "MM/DD/YYYY" },
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      opening: "0.00",
      closing: "100.00",
    });
    expect(monthFirst.lines[0].valueDate).toBe("2026-03-04");
  });

  it("refuses an import whose resolved mapping declares no date format", async () => {
    const { orgId, book } = await freshBook();
    const bank = await accountId(book.id, "1020");
    const profile = await bankAccounts.create(orgId, USER_ID, {
      accountId: bank,
      displayName: "No mapping yet",
      countryCode: "IN",
    });
    expect(profile.csvMapping).toBeNull();

    await expect(
      statements.import(orgId, USER_ID, {
        bankProfileId: profile.id,
        content: ["Date,Description,Reference,Amount", "03/04/2026,ROW,REF,100.00"].join("\n"),
        mapping: { dateColumn: "Date", amountColumn: "Amount" },
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        opening: "0.00",
        closing: "100.00",
      }),
    ).rejects.toThrow(/must declare its date format/i);
  });

  it("refuses a date the declared format cannot read", async () => {
    const fixture = await seedCashBook();
    await expect(
      statements.import(fixture.orgId, USER_ID, {
        bankProfileId: fixture.bankProfileId,
        content: ["Date,Description,Reference,Amount", "31/04/2026,BAD DATE,REF,100.00"].join("\n"),
        mapping: { dateFormat: "DD/MM/YYYY" },
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        opening: "0.00",
        closing: "100.00",
      }),
    ).rejects.toThrow(/not a real calendar date/i);
  });
});

/* ------------------------------------------------- amounts and integrity */

describe("amount parsing and the opening/closing integrity check", () => {
  it("parses the shapes real exports use, and refuses the rest", () => {
    expect(parseAmountToMinor("1,234.56", "INR")).toBe(123_456);
    expect(parseAmountToMinor("₹ 1,00,000.00", "INR")).toBe(10_000_000);
    expect(parseAmountToMinor("(200.00)", "USD")).toBe(-20_000);
    expect(parseAmountToMinor("$1,000", "USD")).toBe(100_000);
    expect(parseAmountToMinor("500.00 CR", "USD")).toBe(50_000);
    expect(parseAmountToMinor("1.234,56", "EUR", ",")).toBe(123_456);
    expect(parseAmountToMinor("   ", "INR")).toBeNull();

    expect(() => parseAmountToMinor("12abc", "INR")).toThrow(StatementCsvError);
    expect(() => parseAmountToMinor("1.2.3", "INR")).toThrow(StatementCsvError);
    expect(() => parseAmountToMinor("100.005", "INR")).toThrow(/decimal places/i);
  });

  it("refuses a file where opening + lines does not equal closing", async () => {
    const fixture = await seedCashBook();

    await expect(
      statements.import(fixture.orgId, USER_ID, {
        bankProfileId: fixture.bankProfileId,
        fileName: "does-not-tie.csv",
        content: qboCsv([
          ["04/05/2026", "CREDIT", "UTR9911", "500.00"],
          ["04/12/2026", "DEBIT", "NEFT4477", "-200.00"],
        ]),
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        opening: "10000.00",
        // 10,000 + 500 − 200 is 10,300, not 10,400.
        closing: "10400.00",
      }),
    ).rejects.toThrow(/does not tie/i);

    // Nothing was written.
    const rows = await db
      .select({ id: bankStatements.id })
      .from(bankStatements)
      .where(eq(bankStatements.bankProfileId, fixture.bankProfileId));
    expect(rows).toHaveLength(0);
  });

  it("warns about duplicate lines rather than silently dropping one", async () => {
    const fixture = await seedCashBook();

    const imported = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      fileName: "twins.csv",
      content: qboCsv([
        ["04/05/2026", "UPI COLLECTION", "UTR7777", "500.00"],
        ["04/05/2026", "UPI COLLECTION", "UTR7777", "500.00"],
      ]),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "11000.00",
    });

    // Both survive — two genuine ₹500 collections on one day is normal.
    expect(imported.lineCount).toBe(2);
    const duplicateWarnings = imported.warnings.filter((w) => w.code === "DUPLICATE_LINE");
    expect(duplicateWarnings).toHaveLength(1);
    expect(duplicateWarnings[0].details?.lineNos).toEqual([1, 2]);
  });
});

/* ------------------------------------------------------------- the presets */

describe("mapping presets are data, not branches", () => {
  it("ships at least three named layouts, including India and US shapes", () => {
    expect(STATEMENT_MAPPING_PRESETS.length).toBeGreaterThanOrEqual(3);
    const codes = STATEMENT_MAPPING_PRESETS.map((p) => p.code);
    expect(codes).toContain("IN_NARRATION_WITHDRAWAL_DEPOSIT");
    expect(codes).toContain("US_QBO_THREE_COLUMN");
    expect(codes).toContain("WISE_MERCURY_SIGNED");
  });

  it("imports an India narration/withdrawal/deposit export with no code change", async () => {
    const fixture = await seedCashBook();

    const imported = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      fileName: "hdfc-april.csv",
      presetCode: "IN_NARRATION_WITHDRAWAL_DEPOSIT",
      content: [
        "Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.",
        "05/04/2026,UPI-ACME CORP-9911,UTR9911,,500.00",
        "12/04/2026,NEFT DR-VENDOR,NEFT4477,200.00,",
        '30/04/2026,"MONTHLY FEE, INCL GST",FEE0430,18.00,',
      ].join("\n"),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "10282.00",
    });

    expect(imported.lines.map((l) => [l.valueDate, l.amountMinor])).toEqual([
      ["2026-04-05", 50_000],
      ["2026-04-12", -20_000],
      ["2026-04-30", -1_800],
    ]);
    // The quoted narration kept its comma.
    expect(imported.lines[2].description).toBe("MONTHLY FEE, INCL GST");
  });
});

/* ------------------------------------------------- suggestions and unmatch */

describe("suggestions are rules, and unmatch respects the period", () => {
  it("suggests within three days, ranks the exact reference first, and excludes the rest", async () => {
    const fixture = await seedCashBook();

    const imported = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      content: qboCsv([["04/10/2026", "ACME CORP UPI CREDIT", "UTR9911", "500.00"]]),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "10500.00",
    });

    const exact = await insertReceipt(fixture, {
      date: "2026-04-10",
      amountMinor: 50_000,
      reference: "UTR9911",
    });
    const nearby = await insertReceipt(fixture, {
      date: "2026-04-12",
      amountMinor: 50_000,
      reference: "UTR0000",
    });
    // Outside the ±3 day window.
    await insertReceipt(fixture, { date: "2026-04-20", amountMinor: 50_000, reference: "UTR9911" });
    // Right window, wrong money.
    await insertReceipt(fixture, { date: "2026-04-10", amountMinor: 49_900, reference: "UTR9911" });

    const { suggestions } = await matching.suggestMatches(fixture.orgId, imported.lines[0].id);
    const ids = suggestions.map((s) => s.id);

    expect(ids).toContain(exact);
    expect(ids).toContain(nearby);
    expect(ids).toHaveLength(2);
    expect(suggestions[0].id).toBe(exact);
    expect(suggestions[0].score).toBeGreaterThan(suggestions[1].score);
    expect(suggestions[0].reasons.join(" ")).toMatch(/Reference matches exactly/);
    expect(suggestions[0].reasons.join(" ")).toMatch(/Same date/);

    // Once matched, the receipt stops being offered to anything else.
    await matching.match(fixture.orgId, USER_ID, imported.lines[0].id, { kind: "receipt", id: exact });
    const after = await matching.suggestMatches(fixture.orgId, imported.lines[0].id);
    expect(after.suggestions.map((s) => s.id)).not.toContain(exact);
  });

  it("unmatches while the period is open and refuses once it is locked", async () => {
    const fixture = await seedCashBook();

    const journal = await ledger.post(fixture.orgId, USER_ID, {
      bookId: fixture.bookId,
      idempotencyKey: "bank_fee:unmatch:post",
      journalDate: "2026-04-30",
      sourceType: "bank_fee",
      lines: [
        { accountId: await accountId(fixture.bookId, "5910"), debitMinor: 1_800 },
        { accountId: fixture.bankAccountId, creditMinor: 1_800 },
      ],
    });

    const imported = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      content: qboCsv([["04/30/2026", "MONTHLY FEE", "FEE0430", "-18.00"]]),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "10000.00",
      closing: "9982.00",
    });

    await matching.match(fixture.orgId, USER_ID, imported.lines[0].id, {
      kind: "journal",
      id: journal.id,
    });
    await expect(matching.unmatch(fixture.orgId, imported.lines[0].id)).resolves.toEqual({
      statementLineId: imported.lines[0].id,
      removed: true,
    });

    // Re-match, lock the period the counterpart lives in, and try again.
    await matching.match(fixture.orgId, USER_ID, imported.lines[0].id, {
      kind: "journal",
      id: journal.id,
    });
    await db
      .update(glPeriods)
      .set({ status: "LOCKED" })
      .where(and(eq(glPeriods.bookId, fixture.bookId), eq(glPeriods.startsOn, "2026-04-01")));

    await expect(matching.unmatch(fixture.orgId, imported.lines[0].id)).rejects.toThrow(/is locked/i);
  });
});

/* ------------------------------------------- marking reconciled is earned */

describe("markReconciled is earned by arithmetic", () => {
  it("refuses a statement whose proof does not hold, and explains what is carried in", async () => {
    const fixture = await seedCashBook();

    // The books carry in 10,000.00 but the statement says the account opened at
    // zero — a genuine 10,000.00 of unexplained difference.
    const imported = await statements.import(fixture.orgId, USER_ID, {
      bankProfileId: fixture.bankProfileId,
      content: qboCsv([
        ["04/05/2026", "CREDIT", "UTR9911", "500.00"],
        ["04/12/2026", "DEBIT", "NEFT4477", "-200.00"],
      ]),
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      opening: "0.00",
      closing: "300.00",
    });

    const proof = await reconciliation.getRecProof(fixture.orgId, imported.statementId);
    expect(proof.holds).toBe(false);
    expect(proof.openingVarianceMinor).toBe(1_000_000);
    expect(proof.differenceMinor).toBe(1_000_000);
    expect(proof.explanation).toMatch(/already there at the start of the period/);

    await expect(
      reconciliation.markReconciled(fixture.orgId, USER_ID, imported.statementId),
    ).rejects.toThrow(/cannot be marked reconciled/i);

    const [row] = await db
      .select({ reconciledAt: bankStatements.reconciledAt })
      .from(bankStatements)
      .where(eq(bankStatements.id, imported.statementId));
    expect(row.reconciledAt).toBeNull();
  });
});
