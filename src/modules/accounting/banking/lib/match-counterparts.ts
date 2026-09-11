/**
 * What a match points at, read back. A receipt, payment or journal expressed
 * the way the bank line is (signed, in the bank account's currency), the checks
 * that it sits in the same book, GL account and currency, and the period that
 * decides whether a match on it may still be undone.
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { apPayments, arReceipts, glJournalLines, glJournals, glPeriods } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { MatchCounterpart, MatchKind, StatementLineContext } from "../matching.types";

/**
 * Load the counterpart and express its amount the way the bank line is
 * expressed: signed, in the bank account's currency.
 */
export async function resolveCounterpart(
  db: Db,
  orgId: string,
  line: StatementLineContext,
  counterpart: MatchCounterpart,
): Promise<{ amountMinor: number; label: string }> {
  if (counterpart.kind === "receipt") {
    const [receipt] = await db
      .select({
        id: arReceipts.id,
        bookId: arReceipts.bookId,
        receiptNumber: arReceipts.receiptNumber,
        depositAccountId: arReceipts.depositAccountId,
        currency: arReceipts.currency,
        amountMinor: arReceipts.amountMinor,
        status: arReceipts.status,
      })
      .from(arReceipts)
      .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, counterpart.id)))
      .limit(1);

    if (!receipt) throw new NotFoundException("Receipt not found");
    assertCounterpartFits(line, {
      bookId: receipt.bookId,
      accountId: receipt.depositAccountId,
      currency: receipt.currency,
      noun: "receipt",
    });
    if (receipt.status !== "POSTED") {
      throw new BadRequestException("A reversed receipt cannot explain a bank line");
    }
    return {
      amountMinor: Number(receipt.amountMinor),
      label: `receipt ${receipt.receiptNumber ?? receipt.id.slice(0, 8)}`,
    };
  }

  if (counterpart.kind === "payment") {
    const [payment] = await db
      .select({
        id: apPayments.id,
        bookId: apPayments.bookId,
        paymentNumber: apPayments.paymentNumber,
        paymentAccountId: apPayments.paymentAccountId,
        currency: apPayments.currency,
        netPaidMinor: apPayments.netPaidMinor,
        status: apPayments.status,
      })
      .from(apPayments)
      .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, counterpart.id)))
      .limit(1);

    if (!payment) throw new NotFoundException("Payment not found");
    assertCounterpartFits(line, {
      bookId: payment.bookId,
      accountId: payment.paymentAccountId,
      currency: payment.currency,
      noun: "payment",
    });
    if (payment.status !== "POSTED") {
      throw new BadRequestException("A reversed payment cannot explain a bank line");
    }
    // Money out of the bank, so it is negative the way the statement line is.
    return {
      amountMinor: -Number(payment.netPaidMinor),
      label: `payment ${payment.paymentNumber ?? payment.id.slice(0, 8)}`,
    };
  }

  const [journal] = await db
    .select({ id: glJournals.id, bookId: glJournals.bookId, journalNumber: glJournals.journalNumber })
    .from(glJournals)
    .where(and(eq(glJournals.orgId, orgId), eq(glJournals.id, counterpart.id)))
    .limit(1);

  if (!journal) throw new NotFoundException("Journal not found");
  if (journal.bookId !== line.profile.bookId) throw new NotFoundException("Journal not found");

  const [movement] = await db
    .select({
      signed: sql<number>`coalesce(sum(case when ${glJournalLines.debitMinor} > 0
          then ${glJournalLines.txnAmountMinor} else -${glJournalLines.txnAmountMinor} end), 0)::bigint`,
      lineCount: sql<number>`count(*)::int`,
    })
    .from(glJournalLines)
    .where(
      and(
        eq(glJournalLines.journalId, journal.id),
        eq(glJournalLines.accountId, line.profile.accountId),
        eq(glJournalLines.txnCurrency, line.profile.currency),
      ),
    );

  if (!movement || Number(movement.lineCount) === 0) {
    throw new BadRequestException(
      `Journal ${journal.journalNumber} does not touch ${line.profile.displayName} in ` +
        `${line.profile.currency}, so it cannot explain this bank line.`,
    );
  }

  return { amountMinor: Number(movement.signed), label: `journal ${journal.journalNumber}` };
}

function assertCounterpartFits(
  line: StatementLineContext,
  counterpart: { bookId: string; accountId: string; currency: string; noun: string },
): void {
  // A counterpart in another book is invisible to this tenant's bank account.
  if (counterpart.bookId !== line.profile.bookId) {
    throw new NotFoundException(`${counterpart.noun[0].toUpperCase()}${counterpart.noun.slice(1)} not found`);
  }
  if (counterpart.accountId !== line.profile.accountId) {
    throw new BadRequestException(
      `That ${counterpart.noun} moved a different GL account, so it cannot explain a line on ` +
        `${line.profile.displayName}.`,
    );
  }
  if (counterpart.currency !== line.profile.currency) {
    throw new BadRequestException(
      `That ${counterpart.noun} is in ${counterpart.currency} but ${line.profile.displayName} ` +
        `reports in ${line.profile.currency}. Reconciliation compares in the bank account's currency.`,
    );
  }
}

/**
 * The period a match's counterpart was posted in: its posting journal's period,
 * or, for a receipt or payment with no journal, the period covering its date.
 */
export async function counterpartPeriod(
  db: Db,
  orgId: string,
  match: { kind: MatchKind; receiptId: string | null; paymentId: string | null; journalId: string | null },
): Promise<{ name: string; status: "OPEN" | "LOCKED" } | null> {
  let journalId: string | null = match.journalId;
  let fallbackDate: string | null = null;
  let bookId: string | null = null;

  if (match.kind === "receipt" && match.receiptId) {
    const [receipt] = await db
      .select({
        postedJournalId: arReceipts.postedJournalId,
        receiptDate: arReceipts.receiptDate,
        bookId: arReceipts.bookId,
      })
      .from(arReceipts)
      .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, match.receiptId)))
      .limit(1);
    journalId = receipt?.postedJournalId ?? null;
    fallbackDate = receipt?.receiptDate ?? null;
    bookId = receipt?.bookId ?? null;
  } else if (match.kind === "payment" && match.paymentId) {
    const [payment] = await db
      .select({
        postedJournalId: apPayments.postedJournalId,
        paymentDate: apPayments.paymentDate,
        bookId: apPayments.bookId,
      })
      .from(apPayments)
      .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, match.paymentId)))
      .limit(1);
    journalId = payment?.postedJournalId ?? null;
    fallbackDate = payment?.paymentDate ?? null;
    bookId = payment?.bookId ?? null;
  }

  if (journalId) {
    const [row] = await db
      .select({ name: glPeriods.name, status: glPeriods.status })
      .from(glJournals)
      .innerJoin(glPeriods, eq(glJournals.periodId, glPeriods.id))
      .where(and(eq(glJournals.orgId, orgId), eq(glJournals.id, journalId)))
      .limit(1);
    return row ?? null;
  }

  if (fallbackDate && bookId) {
    const [row] = await db
      .select({ name: glPeriods.name, status: glPeriods.status })
      .from(glPeriods)
      .where(
        and(
          eq(glPeriods.bookId, bookId),
          lte(glPeriods.startsOn, fallbackDate),
          gte(glPeriods.endsOn, fallbackDate),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  return null;
}
