/**
 * The two halves of the unreconciled view as reads: GL movements on the cash
 * account that no match explains, and statement lines nothing is matched to.
 * `MatchingService.cashJournalLines` and `unmatchedStatementLines` delegate
 * here, and `ReconciliationService` reads both through them for the proof.
 */
import { and, asc, eq, exists, gte, lte, not, or, sql } from "drizzle-orm";
import {
  apPayments,
  arReceipts,
  bankMatches,
  bankStatementLines,
  bankStatements,
  glJournalLines,
  glJournals,
} from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { assertIsoDate } from "../../kernel/fiscal-calendar";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { BankAccountSummary } from "../bank-accounts.service";
import type { UnreconciledGlLine, UnreconciledStatementLine } from "../matching.types";

/**
 * GL movements on the cash account, in the bank's currency.
 *
 * A journal is *explained* when a match points at it directly, or when it is
 * the posting journal of a receipt or payment that is itself matched — the
 * receipt's cash line and the bank line are the same event seen twice, so
 * matching the receipt explains the GL line too.
 */
export async function loadCashJournalLines(
  db: Db,
  orgId: string,
  profile: BankAccountSummary,
  options: { from?: string; to: string; onlyUnexplained?: boolean; tx?: DbOrTx },
): Promise<UnreconciledGlLine[]> {
  const tx = options.tx ?? db;

  const matchedDirectly = exists(
    db.select({ one: sql`1` }).from(bankMatches).where(eq(bankMatches.journalId, glJournals.id)),
  );
  const matchedViaReceipt = exists(
    db
      .select({ one: sql`1` })
      .from(bankMatches)
      .innerJoin(arReceipts, eq(bankMatches.receiptId, arReceipts.id))
      .where(eq(arReceipts.postedJournalId, glJournals.id)),
  );
  const matchedViaPayment = exists(
    db
      .select({ one: sql`1` })
      .from(bankMatches)
      .innerJoin(apPayments, eq(bankMatches.paymentId, apPayments.id))
      .where(eq(apPayments.postedJournalId, glJournals.id)),
  );
  const explained = or(matchedDirectly, matchedViaReceipt, matchedViaPayment);

  const conditions = [
    eq(glJournalLines.orgId, orgId),
    eq(glJournalLines.bookId, profile.bookId),
    eq(glJournalLines.accountId, profile.accountId),
    eq(glJournalLines.txnCurrency, profile.currency),
    lte(glJournals.journalDate, assertIsoDate(options.to)),
  ];
  if (options.from) conditions.push(gte(glJournals.journalDate, assertIsoDate(options.from)));
  if (options.onlyUnexplained && explained) conditions.push(not(explained));

  const rows = await tx
    .select({
      journalId: glJournals.id,
      journalNumber: glJournals.journalNumber,
      journalDate: glJournals.journalDate,
      memo: glJournals.memo,
      sourceType: glJournals.sourceType,
      sourceId: glJournals.sourceId,
      lineId: glJournalLines.id,
      lineNo: glJournalLines.lineNo,
      accountId: glJournalLines.accountId,
      debitMinor: glJournalLines.debitMinor,
      txnAmountMinor: glJournalLines.txnAmountMinor,
      txnCurrency: glJournalLines.txnCurrency,
      functionalAmountMinor: glJournalLines.functionalAmountMinor,
      creditMinor: glJournalLines.creditMinor,
      description: glJournalLines.description,
    })
    .from(glJournalLines)
    .innerJoin(glJournals, eq(glJournalLines.journalId, glJournals.id))
    .where(and(...conditions))
    .orderBy(asc(glJournals.journalDate), asc(glJournals.journalNumber), asc(glJournalLines.lineNo));

  return rows.map((r) => {
    const signed = Number(r.debitMinor) > 0 ? Number(r.txnAmountMinor) : -Number(r.txnAmountMinor);
    return {
      journalId: r.journalId,
      journalNumber: r.journalNumber,
      journalDate: r.journalDate,
      lineId: r.lineId,
      lineNo: r.lineNo,
      accountId: r.accountId,
      amountMinor: signed,
      txnCurrency: r.txnCurrency,
      functionalAmountMinor:
        Number(r.debitMinor) > 0
          ? Number(r.functionalAmountMinor)
          : -Number(r.functionalAmountMinor),
      memo: r.memo,
      description: r.description,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
    };
  });
}

/** Statement lines with no match, either for one statement or a whole account. */
export async function loadUnmatchedStatementLines(
  db: Db,
  orgId: string,
  options: { statementId?: string; bankProfileId?: string; to?: string; tx?: DbOrTx },
): Promise<UnreconciledStatementLine[]> {
  const tx = options.tx ?? db;

  const conditions = [
    eq(bankStatementLines.orgId, orgId),
    not(
      exists(
        db
          .select({ one: sql`1` })
          .from(bankMatches)
          .where(eq(bankMatches.statementLineId, bankStatementLines.id)),
      ),
    ),
  ];
  if (options.statementId) conditions.push(eq(bankStatementLines.statementId, options.statementId));
  if (options.bankProfileId) conditions.push(eq(bankStatements.bankProfileId, options.bankProfileId));
  if (options.to) conditions.push(lte(bankStatementLines.valueDate, assertIsoDate(options.to)));

  const rows = await tx
    .select({
      id: bankStatementLines.id,
      statementId: bankStatementLines.statementId,
      lineNo: bankStatementLines.lineNo,
      valueDate: bankStatementLines.valueDate,
      amountMinor: bankStatementLines.amountMinor,
      description: bankStatementLines.description,
      bankReference: bankStatementLines.bankReference,
    })
    .from(bankStatementLines)
    .innerJoin(bankStatements, eq(bankStatementLines.statementId, bankStatements.id))
    .where(and(...conditions))
    .orderBy(asc(bankStatementLines.valueDate), asc(bankStatementLines.lineNo));

  return rows.map((r) => ({ ...r, amountMinor: Number(r.amountMinor) }));
}
