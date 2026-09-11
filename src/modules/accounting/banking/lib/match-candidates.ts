/**
 * Where suggestions come from. Posted receipts (money in) or payments (money
 * out) on the bank account's GL account, for exactly the bank line's amount,
 * inside the date window; and journals whose net movement on that account
 * equals it. Anything already matched is left out, because a match is 1:1.
 */
import { and, asc, eq, exists, gte, lte, not, sql } from "drizzle-orm";
import { apPayments, arReceipts, bankMatches, glParties } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { MatchSuggestion, StatementLineContext, UnreconciledGlLine } from "../matching.types";

export async function receiptCandidates(
  db: Db,
  orgId: string,
  line: StatementLineContext,
  absolute: number,
  from: string,
  to: string,
): Promise<MatchSuggestion[]> {
  const rows = await db
    .select({
      id: arReceipts.id,
      receiptNumber: arReceipts.receiptNumber,
      receiptDate: arReceipts.receiptDate,
      amountMinor: arReceipts.amountMinor,
      currency: arReceipts.currency,
      reference: arReceipts.reference,
      memo: arReceipts.memo,
      partyName: glParties.displayName,
    })
    .from(arReceipts)
    .innerJoin(glParties, eq(arReceipts.partyId, glParties.id))
    .where(
      and(
        eq(arReceipts.orgId, orgId),
        eq(arReceipts.bookId, line.profile.bookId),
        eq(arReceipts.depositAccountId, line.profile.accountId),
        eq(arReceipts.currency, line.profile.currency),
        eq(arReceipts.amountMinor, absolute),
        eq(arReceipts.status, "POSTED"),
        gte(arReceipts.receiptDate, from),
        lte(arReceipts.receiptDate, to),
        // Already explaining another bank line — 1:1 means it is unavailable.
        not(
          exists(
            db
              .select({ one: sql`1` })
              .from(bankMatches)
              .where(eq(bankMatches.receiptId, arReceipts.id)),
          ),
        ),
      ),
    )
    .orderBy(asc(arReceipts.receiptDate))
    .limit(50);

  return rows.map((r) => ({
    kind: "receipt" as const,
    id: r.id,
    label: `Receipt ${r.receiptNumber ?? r.id.slice(0, 8)} — ${r.partyName}`,
    date: r.receiptDate,
    amountMinor: Number(r.amountMinor),
    currency: r.currency,
    reference: r.reference,
    score: 0,
    reasons: [],
    searchText: [r.reference, r.memo, r.partyName, r.receiptNumber].filter(Boolean).join(" "),
  }));
}

export async function paymentCandidates(
  db: Db,
  orgId: string,
  line: StatementLineContext,
  absolute: number,
  from: string,
  to: string,
): Promise<MatchSuggestion[]> {
  const rows = await db
    .select({
      id: apPayments.id,
      paymentNumber: apPayments.paymentNumber,
      paymentDate: apPayments.paymentDate,
      netPaidMinor: apPayments.netPaidMinor,
      currency: apPayments.currency,
      reference: apPayments.reference,
      memo: apPayments.memo,
      partyName: glParties.displayName,
    })
    .from(apPayments)
    .innerJoin(glParties, eq(apPayments.partyId, glParties.id))
    .where(
      and(
        eq(apPayments.orgId, orgId),
        eq(apPayments.bookId, line.profile.bookId),
        eq(apPayments.paymentAccountId, line.profile.accountId),
        eq(apPayments.currency, line.profile.currency),
        eq(apPayments.netPaidMinor, absolute),
        eq(apPayments.status, "POSTED"),
        gte(apPayments.paymentDate, from),
        lte(apPayments.paymentDate, to),
        not(
          exists(
            db
              .select({ one: sql`1` })
              .from(bankMatches)
              .where(eq(bankMatches.paymentId, apPayments.id)),
          ),
        ),
      ),
    )
    .orderBy(asc(apPayments.paymentDate))
    .limit(50);

  return rows.map((r) => ({
    kind: "payment" as const,
    id: r.id,
    // Money out, so the suggestion is signed the way the bank line is.
    label: `Payment ${r.paymentNumber ?? r.id.slice(0, 8)} — ${r.partyName}`,
    date: r.paymentDate,
    amountMinor: -Number(r.netPaidMinor),
    currency: r.currency,
    reference: r.reference,
    score: 0,
    reasons: [],
    searchText: [r.reference, r.memo, r.partyName, r.paymentNumber].filter(Boolean).join(" "),
  }));
}

/**
 * The journals among `items` whose net movement on the cash account equals the
 * bank line's amount, as suggestions. `items` is the cash account's unexplained
 * lines inside the date window.
 */
export function journalSuggestions(
  line: StatementLineContext,
  items: readonly UnreconciledGlLine[],
): MatchSuggestion[] {
  // A journal may touch the cash account on more than one line; the match is
  // against the journal, so its net movement is what has to agree.
  const byJournal = new Map<string, { row: UnreconciledGlLine; net: number }>();
  for (const item of items) {
    const seen = byJournal.get(item.journalId);
    if (seen) seen.net += item.amountMinor;
    else byJournal.set(item.journalId, { row: item, net: item.amountMinor });
  }

  return [...byJournal.values()]
    .filter((j) => j.net === line.amountMinor)
    .map<MatchSuggestion>((j) => ({
      kind: "journal" as const,
      id: j.row.journalId,
      label: `Journal ${j.row.journalNumber}${j.row.memo ? ` — ${j.row.memo}` : ""}`,
      date: j.row.journalDate,
      amountMinor: j.net,
      currency: line.profile.currency,
      reference: j.row.sourceId,
      score: 0,
      reasons: [],
      searchText: [j.row.memo, j.row.description, j.row.journalNumber, j.row.sourceType]
        .filter(Boolean)
        .join(" "),
    }));
}
