/**
 * Reading the ledger back: a journal by its idempotency key, a journal with its
 * lines, and the trial balance.
 *
 * Split out of `ledger.service.ts`, whose `loadJournal` and `trialBalance`
 * delegate here. Reads only — the ledger's writes stay in that service.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { glAccounts, glBooks, glJournalLines, glJournals } from "../../../../db/schema";
import { assertIsoDate } from "../fiscal-calendar";
import type { DbOrTx } from "../sequence.service";
import type { PostedJournal, PostedJournalLine } from "../ledger.types";

/** One account's line in the trial balance. */
export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

export async function findByIdempotencyKey(
  orgId: string,
  bookId: string,
  idempotencyKey: string,
  tx: DbOrTx,
): Promise<PostedJournal | null> {
  const [row] = await tx
    .select({ id: glJournals.id })
    .from(glJournals)
    .where(
      and(
        eq(glJournals.orgId, orgId),
        eq(glJournals.bookId, bookId),
        eq(glJournals.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row ? loadPostedJournal(orgId, row.id, tx) : null;
}

/** Header plus lines, joined to accounts so a caller never re-queries. */
export async function loadPostedJournal(
  orgId: string,
  journalId: string,
  tx: DbOrTx,
): Promise<PostedJournal | null> {
  const [header] = await tx
    .select({
      id: glJournals.id,
      bookId: glJournals.bookId,
      journalNumber: glJournals.journalNumber,
      journalDate: glJournals.journalDate,
      periodId: glJournals.periodId,
      memo: glJournals.memo,
      sourceType: glJournals.sourceType,
      sourceId: glJournals.sourceId,
      idempotencyKey: glJournals.idempotencyKey,
      reversesJournalId: glJournals.reversesJournalId,
      reversedByJournalId: glJournals.reversedByJournalId,
      postedByUserId: glJournals.postedByUserId,
      postedAt: glJournals.postedAt,
      baseCurrency: glBooks.baseCurrency,
    })
    .from(glJournals)
    .innerJoin(glBooks, eq(glJournals.bookId, glBooks.id))
    .where(and(eq(glJournals.orgId, orgId), eq(glJournals.id, journalId)))
    .limit(1);

  if (!header) return null;

  const lineRows = await tx
    .select({
      id: glJournalLines.id,
      lineNo: glJournalLines.lineNo,
      accountId: glJournalLines.accountId,
      accountCode: glAccounts.code,
      accountName: glAccounts.name,
      debitMinor: glJournalLines.debitMinor,
      creditMinor: glJournalLines.creditMinor,
      txnCurrency: glJournalLines.txnCurrency,
      txnAmountMinor: glJournalLines.txnAmountMinor,
      functionalCurrency: glJournalLines.functionalCurrency,
      functionalAmountMinor: glJournalLines.functionalAmountMinor,
      fxRate: glJournalLines.fxRate,
      description: glJournalLines.description,
    })
    .from(glJournalLines)
    .innerJoin(glAccounts, eq(glJournalLines.accountId, glAccounts.id))
    .where(eq(glJournalLines.journalId, journalId))
    .orderBy(asc(glJournalLines.lineNo));

  const lines: PostedJournalLine[] = lineRows;

  return {
    ...header,
    lines,
    totalDebitMinor: lines.reduce((a, l) => a + l.debitMinor, 0),
    totalCreditMinor: lines.reduce((a, l) => a + l.creditMinor, 0),
    functionalCurrency: header.baseCurrency,
    replayed: false,
  };
}

/**
 * Trial balance straight from the lines. There is no balances table to drift
 * out of step with the ledger — PRD 06 forbids one, and this is why it can.
 */
export async function readTrialBalance(
  orgId: string,
  bookId: string,
  asOf: string,
  tx: DbOrTx,
): Promise<TrialBalanceRow[]> {
  const rows = await tx
    .select({
      accountId: glAccounts.id,
      code: glAccounts.code,
      name: glAccounts.name,
      accountType: glAccounts.accountType,
      debitMinor: sql<number>`coalesce(sum(${glJournalLines.debitMinor}), 0)::bigint`,
      creditMinor: sql<number>`coalesce(sum(${glJournalLines.creditMinor}), 0)::bigint`,
    })
    .from(glJournalLines)
    .innerJoin(glAccounts, eq(glJournalLines.accountId, glAccounts.id))
    .innerJoin(glJournals, eq(glJournalLines.journalId, glJournals.id))
    .where(
      and(
        eq(glJournalLines.orgId, orgId),
        eq(glJournalLines.bookId, bookId),
        lte(glJournals.journalDate, assertIsoDate(asOf)),
      ),
    )
    .groupBy(glAccounts.id, glAccounts.code, glAccounts.name, glAccounts.accountType)
    .orderBy(asc(glAccounts.code));

  return rows.map((r) => ({
    ...r,
    debitMinor: Number(r.debitMinor),
    creditMinor: Number(r.creditMinor),
    balanceMinor: Number(r.debitMinor) - Number(r.creditMinor),
  }));
}
