/**
 * What a journal must satisfy before the kernel writes it: a book, a period
 * that covers the date and is open, currencies the book trades in, and
 * postable accounts — then a number from the book's journal series.
 *
 * Split out of `ledger.service.ts`, which calls `prepareJournal` inside its
 * posting transaction. Reads and the sequence allocation only; the journal and
 * line inserts stay in that service (`ledger-boundary.spec.ts`).
 */
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { glAccounts, glBookCurrencies, glBooks, glFiscalYears, glPeriods } from "../../../../db/schema";
import type { PackRegistry } from "../../packs/pack.registry";
import type { DbOrTx, SequenceService } from "../sequence.service";
import { LedgerRejection, type PostJournalCommand, type PostedJournal } from "../ledger.types";
import { assertBalanced, normalizeLines, validateDate, type NormalizedLine } from "./journal-lines";
import { findByIdempotencyKey } from "./journal-reads";

/** A replay to return as it stands, or a journal ready for its first write. */
export type PreparedJournal =
  | { kind: "replay"; journal: PostedJournal }
  | {
      kind: "ready";
      journalDate: string;
      journalNumber: string;
      periodId: string;
      lines: NormalizedLine[];
    };

/**
 * Everything `LedgerService.postWithin` does before its first write, in the
 * order it has always done it: the date and the idempotency key, the replay,
 * the book, the lines and their balance, the period, the currencies and
 * accounts, and last the journal number, so a rejected journal never spends
 * one.
 */
export async function prepareJournal(
  sequences: SequenceService,
  packs: PackRegistry,
  orgId: string,
  command: PostJournalCommand,
  tx: DbOrTx,
): Promise<PreparedJournal> {
  const journalDate = validateDate(command.journalDate);

  if (!command.idempotencyKey?.trim()) {
    throw new LedgerRejection("IDEMPOTENCY_CONFLICT", "An idempotency key is required");
  }

  // An idempotent replay must not do any of the work below, so check first.
  const replay = await findByIdempotencyKey(orgId, command.bookId, command.idempotencyKey, tx);
  if (replay) return { kind: "replay", journal: replay };

  const book = await loadBook(orgId, command.bookId, tx);
  const lines = normalizeLines(command.lines, book.baseCurrency);
  assertBalanced(lines);

  const period = await resolvePeriod(command.bookId, journalDate, tx);
  await assertCurrenciesAllowed(command.bookId, lines, tx);
  await assertAccountsPostable(command.bookId, lines, tx);

  const fiscalYear = await loadFiscalYear(period.fiscalYearId, tx);
  const pack = packs.get(book.localizationPack);
  const journalNumber = await sequences.allocate(
    {
      orgId,
      bookId: command.bookId,
      kind: "journal",
      series: pack.documentSeries.journal,
      fiscalYear: { id: fiscalYear.id, name: fiscalYear.name },
    },
    tx,
  );

  return { kind: "ready", journalDate, journalNumber, periodId: period.id, lines };
}

export async function loadBook(orgId: string, bookId: string, tx: DbOrTx) {
  const [book] = await tx
    .select({
      id: glBooks.id,
      baseCurrency: glBooks.baseCurrency,
      localizationPack: glBooks.localizationPack,
      status: glBooks.status,
    })
    .from(glBooks)
    .where(and(eq(glBooks.orgId, orgId), eq(glBooks.id, bookId), isNull(glBooks.deletedAt)))
    .limit(1);

  if (!book) {
    throw new LedgerRejection("BOOK_NOT_FOUND", `Book ${bookId} was not found`);
  }
  return book;
}

/**
 * The period containing the journal date. A missing period is as fatal as a
 * locked one — the kernel never invents a period to post into.
 */
export async function resolvePeriod(bookId: string, journalDate: string, tx: DbOrTx) {
  const [period] = await tx
    .select({
      id: glPeriods.id,
      status: glPeriods.status,
      name: glPeriods.name,
      fiscalYearId: glPeriods.fiscalYearId,
    })
    .from(glPeriods)
    .where(
      and(
        eq(glPeriods.bookId, bookId),
        lte(glPeriods.startsOn, journalDate),
        gte(glPeriods.endsOn, journalDate),
      ),
    )
    .limit(1);

  if (!period) {
    throw new LedgerRejection(
      "PERIOD_NOT_FOUND",
      `No accounting period covers ${journalDate}. Open the fiscal year first.`,
    );
  }
  if (period.status === "LOCKED") {
    throw new LedgerRejection(
      "PERIOD_LOCKED",
      `Period ${period.name} is locked and cannot accept postings`,
      undefined,
      { periodId: period.id, periodName: period.name },
    );
  }
  return period;
}

export async function loadFiscalYear(fiscalYearId: string, tx: DbOrTx) {
  const [fy] = await tx
    .select({ id: glFiscalYears.id, name: glFiscalYears.name })
    .from(glFiscalYears)
    .where(eq(glFiscalYears.id, fiscalYearId))
    .limit(1);
  if (!fy) throw new LedgerRejection("PERIOD_NOT_FOUND", "The period's fiscal year is missing");
  return fy;
}

/**
 * Every transaction currency must be one the book has enabled (PRD 11 M4).
 *
 * Without this a typo posts a journal in a currency the business does not
 * trade in, and the first anyone knows about the phantom exposure is a
 * balance sheet that will not explain itself. Enabling a currency is one
 * deliberate action; posting in one should not be an accident.
 */
export async function assertCurrenciesAllowed(
  bookId: string,
  lines: readonly NormalizedLine[],
  tx: DbOrTx,
): Promise<void> {
  const used = [...new Set(lines.map((l) => l.txnCurrency))];
  // The functional currency is always permitted; only look further if a line
  // is denominated in something else.
  const foreign = used.filter((c) => c !== lines[0]?.functionalCurrency);
  if (foreign.length === 0) return;

  const rows = await tx
    .select({ currencyCode: glBookCurrencies.currencyCode })
    .from(glBookCurrencies)
    .where(eq(glBookCurrencies.bookId, bookId));
  const allowed = new Set(rows.map((r) => r.currencyCode));

  lines.forEach((line, index) => {
    if (line.txnCurrency === line.functionalCurrency) return;
    if (allowed.has(line.txnCurrency)) return;
    throw new LedgerRejection(
      "CURRENCY_INVALID",
      `Line ${index + 1}: this book does not trade in ${line.txnCurrency}. ` +
        "Enable the currency in accounting settings first.",
      index,
      { currency: line.txnCurrency },
    );
  });
}

/**
 * Every account must belong to this book, be a posting account, be active,
 * and accept the line's currency. Scoping the query by `bookId` is also what
 * makes an account borrowed from another org resolve to "not found" (test 9).
 */
export async function assertAccountsPostable(
  bookId: string,
  lines: readonly NormalizedLine[],
  tx: DbOrTx,
): Promise<void> {
  const wanted = [...new Set(lines.map((l) => l.accountId))];
  const rows = await tx
    .select({
      id: glAccounts.id,
      code: glAccounts.code,
      isHeader: glAccounts.isHeader,
      isActive: glAccounts.isActive,
      currencyRestriction: glAccounts.currencyRestriction,
    })
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.bookId, bookId),
        inArray(glAccounts.id, wanted),
        isNull(glAccounts.deletedAt),
      ),
    );

  const byId = new Map(rows.map((r) => [r.id, r]));

  lines.forEach((line, index) => {
    const account = byId.get(line.accountId);
    if (!account) {
      throw new LedgerRejection(
        "ACCOUNT_NOT_FOUND",
        `Line ${index + 1}: account ${line.accountId} does not exist in this book`,
        index,
      );
    }
    if (account.isHeader) {
      throw new LedgerRejection(
        "ACCOUNT_IS_HEADER",
        `Line ${index + 1}: ${account.code} is a header account and cannot be posted to`,
        index,
      );
    }
    if (!account.isActive) {
      throw new LedgerRejection(
        "ACCOUNT_INACTIVE",
        `Line ${index + 1}: account ${account.code} is inactive`,
        index,
      );
    }
    if (account.currencyRestriction && account.currencyRestriction !== line.txnCurrency) {
      throw new LedgerRejection(
        "ACCOUNT_CURRENCY_RESTRICTED",
        `Line ${index + 1}: account ${account.code} only accepts ${account.currencyRestriction}, ` +
          `got ${line.txnCurrency}`,
        index,
      );
    }
  });
}
