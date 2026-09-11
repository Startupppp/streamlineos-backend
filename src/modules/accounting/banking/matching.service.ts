/**
 * Matching a bank line to something in the books (PRD 04 M5, M7).
 *
 * The suggestion engine is **rules only** — amount equality, a ±3 day window,
 * and a reference/description similarity boost. No model, no embedding, no
 * "confidence" that cannot be explained to an auditor. Every suggestion carries
 * the reasons it scored what it scored, because a human has to accept it.
 *
 * A match is strictly 1:1. Four partial unique indexes on `bank_matches` say so
 * — one per statement line, one per receipt, one per payment, one per journal —
 * and this service catches `23505` and turns it into a 409 that names which of
 * them fired. The database is the enforcement; the code is the message.
 *
 * Amounts are compared in the **bank account's currency**, never the functional
 * one. A USD account on INR books is reconciled against a USD statement; the
 * INR figures on the same journal lines are a different question.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, exists, gte, isNull, lte, not, or, sql } from "drizzle-orm";
import {
  apPayments,
  arReceipts,
  bankMatches,
  bankProfiles,
  bankStatementLines,
  bankStatements,
  glAccounts,
  glJournalLines,
  glJournals,
  glParties,
  glPeriods,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../kernel/sequence.service";
import { addDays, assertIsoDate } from "../kernel/fiscal-calendar";
import { money, toDecimalString } from "../kernel/money";
import { BankAccountsService, type BankAccountSummary } from "./bank-accounts.service";
import { isUniqueViolation, violatedConstraint } from "./pg-errors";

/** PRD 04: candidates are within three days either side of the bank's value date. */
export const MATCH_DATE_WINDOW_DAYS = 3;

export type MatchKind = "receipt" | "payment" | "journal";

export interface MatchCounterpart {
  kind: MatchKind;
  id: string;
}

export interface StatementLineContext {
  id: string;
  statementId: string;
  lineNo: number;
  valueDate: string;
  amountMinor: number;
  description: string | null;
  bankReference: string | null;
  profile: BankAccountSummary;
  periodStart: string;
  periodEnd: string;
}

export interface MatchSuggestion {
  kind: MatchKind;
  id: string;
  label: string;
  date: string;
  /** Signed, in the bank account's currency. Positive is money in. */
  amountMinor: number;
  currency: string;
  reference: string | null;
  score: number;
  reasons: string[];
  /** The text the similarity boost reads. Internal to the scoring rules. */
  searchText?: string;
}

export interface RecordedMatch {
  id: string;
  statementLineId: string;
  kind: MatchKind;
  counterpartId: string;
  amountMinor: number;
  currency: string;
  matchedAt: Date;
}

export interface UnreconciledGlLine {
  journalId: string;
  journalNumber: string;
  journalDate: string;
  lineId: string;
  lineNo: number;
  accountId: string;
  /** Signed, in the bank account's currency. */
  amountMinor: number;
  txnCurrency: string;
  functionalAmountMinor: number;
  memo: string | null;
  description: string | null;
  sourceType: string;
  sourceId: string | null;
}

export interface UnreconciledStatementLine {
  id: string;
  statementId: string;
  lineNo: number;
  valueDate: string;
  amountMinor: number;
  description: string | null;
  bankReference: string | null;
}

export interface UnreconciledView {
  bookId: string;
  accountId: string;
  bankProfileId: string;
  currency: string;
  asOf: string;
  statementLines: UnreconciledStatementLine[];
  statementLinesTotalMinor: number;
  glLines: UnreconciledGlLine[];
  glLinesTotalMinor: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class MatchingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly bankAccounts: BankAccountsService,
  ) {}

  /* --------------------------------------------------------- suggestions */

  /**
   * Candidates for one bank line, best first.
   *
   * The amount must be exactly equal — a bank line of ₹500.00 is never
   * "probably" the ₹499.50 receipt. Everything else (date proximity, reference
   * equality, description overlap) only orders the candidates that already
   * agree on the money.
   */
  async suggestMatches(
    orgId: string,
    statementLineId: string,
    options: { limit?: number } = {},
  ): Promise<{ line: StatementLineContext; suggestions: MatchSuggestion[] }> {
    const line = await this.requireStatementLine(orgId, statementLineId);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));

    const from = addDays(line.valueDate, -MATCH_DATE_WINDOW_DAYS);
    const to = addDays(line.valueDate, MATCH_DATE_WINDOW_DAYS);
    const absolute = Math.abs(line.amountMinor);
    const isMoneyIn = line.amountMinor > 0;

    const candidates: MatchSuggestion[] = [];

    if (isMoneyIn) {
      candidates.push(...(await this.receiptCandidates(orgId, line, absolute, from, to)));
    } else {
      candidates.push(...(await this.paymentCandidates(orgId, line, absolute, from, to)));
    }
    candidates.push(...(await this.journalCandidates(orgId, line, from, to)));

    for (const candidate of candidates) {
      const { score, reasons } = this.scoreCandidate(line, candidate);
      candidate.score = score;
      candidate.reasons = reasons;
    }

    candidates.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
    return { line, suggestions: candidates.slice(0, limit) };
  }

  private async receiptCandidates(
    orgId: string,
    line: StatementLineContext,
    absolute: number,
    from: string,
    to: string,
  ): Promise<MatchSuggestion[]> {
    const rows = await this.db
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
              this.db
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

  private async paymentCandidates(
    orgId: string,
    line: StatementLineContext,
    absolute: number,
    from: string,
    to: string,
  ): Promise<MatchSuggestion[]> {
    const rows = await this.db
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
              this.db
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

  private async journalCandidates(
    orgId: string,
    line: StatementLineContext,
    from: string,
    to: string,
  ): Promise<MatchSuggestion[]> {
    const items = await this.cashJournalLines(orgId, line.profile, {
      from,
      to,
      onlyUnexplained: true,
    });

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

  /**
   * Deterministic, explainable, and entirely local: 50 for the amount agreeing
   * at all, 20 for how close the dates are, 20 for the reference, 10 for words
   * in common. No model is consulted and none ever will be — a reconciliation a
   * human cannot audit is not a reconciliation.
   */
  private scoreCandidate(
    line: StatementLineContext,
    candidate: MatchSuggestion,
  ): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 50;
    reasons.push(
      `Amount matches exactly (${toDecimalString(money(candidate.amountMinor, candidate.currency))} ${candidate.currency})`,
    );

    const dayGap = Math.abs(daysBetween(line.valueDate, candidate.date));
    const dateScore = dayGap === 0 ? 20 : dayGap === 1 ? 15 : dayGap === 2 ? 10 : dayGap === 3 ? 5 : 0;
    score += dateScore;
    reasons.push(
      dayGap === 0 ? "Same date as the bank line" : `${dayGap} day${dayGap === 1 ? "" : "s"} from the bank line`,
    );

    const lineReference = normalizeReference(line.bankReference);
    const candidateReference = normalizeReference(candidate.reference);
    if (lineReference && candidateReference) {
      if (lineReference === candidateReference) {
        score += 20;
        reasons.push(`Reference matches exactly (${candidate.reference})`);
      } else if (
        lineReference.includes(candidateReference) ||
        candidateReference.includes(lineReference)
      ) {
        score += 12;
        reasons.push(`Reference overlaps (${candidate.reference})`);
      }
    }

    const overlap = diceCoefficient(
      tokenize(line.description ?? line.bankReference ?? ""),
      tokenize(candidate.searchText ?? candidate.label),
    );
    if (overlap > 0) {
      const descriptionScore = Math.round(10 * overlap);
      score += descriptionScore;
      if (descriptionScore > 0) reasons.push(`Description overlaps the counterpart (${Math.round(overlap * 100)}%)`);
    }

    return { score: Math.min(100, score), reasons };
  }

  /* --------------------------------------------------------------- match */

  async match(
    orgId: string,
    userId: string | null,
    statementLineId: string,
    counterpart: MatchCounterpart,
  ): Promise<RecordedMatch> {
    const line = await this.requireStatementLine(orgId, statementLineId);
    const resolved = await this.resolveCounterpart(orgId, line, counterpart);

    // PRD 04 acceptance 4 — compared in the bank account's currency, not the
    // book's functional currency.
    if (resolved.amountMinor !== line.amountMinor) {
      throw new BadRequestException(
        `Amounts do not match: the bank line is ` +
          `${toDecimalString(money(line.amountMinor, line.profile.currency))} ${line.profile.currency} ` +
          `and ${resolved.label} is ` +
          `${toDecimalString(money(resolved.amountMinor, line.profile.currency))} ${line.profile.currency}. ` +
          "A match must be for the same amount in the bank account's own currency.",
      );
    }

    try {
      const [row] = await this.db
        .insert(bankMatches)
        .values({
          orgId,
          bookId: line.profile.bookId,
          statementLineId: line.id,
          kind: counterpart.kind,
          receiptId: counterpart.kind === "receipt" ? counterpart.id : null,
          paymentId: counterpart.kind === "payment" ? counterpart.id : null,
          journalId: counterpart.kind === "journal" ? counterpart.id : null,
          matchedBy: userId,
        })
        .returning();
      if (!row) throw new ConflictException("Could not record the match");

      return {
        id: row.id,
        statementLineId: row.statementLineId,
        kind: row.kind,
        counterpartId: counterpart.id,
        amountMinor: line.amountMinor,
        currency: line.profile.currency,
        matchedAt: row.matchedAt,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(this.conflictMessage(error, line, counterpart));
      }
      throw error;
    }
  }

  /** A 409 that says which side was already spoken for. */
  private conflictMessage(
    error: unknown,
    line: StatementLineContext,
    counterpart: MatchCounterpart,
  ): string {
    const detail = violatedConstraint(error);

    if (detail.includes("statement_line")) {
      return (
        `Bank line ${line.lineNo} (${line.valueDate}, ` +
        `${toDecimalString(money(line.amountMinor, line.profile.currency))} ${line.profile.currency}) ` +
        "is already matched. Unmatch it first — a bank line explains exactly one thing."
      );
    }
    const noun =
      counterpart.kind === "receipt" ? "receipt" : counterpart.kind === "payment" ? "payment" : "journal";
    return (
      `That ${noun} is already matched to a different bank line. One ${noun} cannot explain two ` +
      "bank movements; unmatch the other line first."
    );
  }

  /* ------------------------------------------------------------- unmatch */

  /**
   * Undo a match while the counterpart's period is still open.
   *
   * The match itself carries no accounting; it is a link. But unpicking it once
   * the period is locked would let a closed month's reconciliation change after
   * the fact, so the period gates it.
   */
  async unmatch(orgId: string, statementLineId: string): Promise<{ statementLineId: string; removed: true }> {
    const [existing] = await this.db
      .select({
        id: bankMatches.id,
        bookId: bankMatches.bookId,
        kind: bankMatches.kind,
        receiptId: bankMatches.receiptId,
        paymentId: bankMatches.paymentId,
        journalId: bankMatches.journalId,
      })
      .from(bankMatches)
      .where(and(eq(bankMatches.orgId, orgId), eq(bankMatches.statementLineId, statementLineId)))
      .limit(1);

    if (!existing) throw new NotFoundException("That bank line is not matched");

    const period = await this.counterpartPeriod(orgId, existing);
    if (period && period.status === "LOCKED") {
      throw new ConflictException(
        `${period.name} is locked, so this match cannot be undone. Reopen the period, or correct the ` +
          "books with a reversing journal instead.",
      );
    }

    await this.db.delete(bankMatches).where(and(eq(bankMatches.orgId, orgId), eq(bankMatches.id, existing.id)));
    return { statementLineId, removed: true };
  }

  private async counterpartPeriod(
    orgId: string,
    match: { kind: MatchKind; receiptId: string | null; paymentId: string | null; journalId: string | null },
  ): Promise<{ name: string; status: "OPEN" | "LOCKED" } | null> {
    let journalId: string | null = match.journalId;
    let fallbackDate: string | null = null;
    let bookId: string | null = null;

    if (match.kind === "receipt" && match.receiptId) {
      const [receipt] = await this.db
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
      const [payment] = await this.db
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
      const [row] = await this.db
        .select({ name: glPeriods.name, status: glPeriods.status })
        .from(glJournals)
        .innerJoin(glPeriods, eq(glJournals.periodId, glPeriods.id))
        .where(and(eq(glJournals.orgId, orgId), eq(glJournals.id, journalId)))
        .limit(1);
      return row ?? null;
    }

    if (fallbackDate && bookId) {
      const [row] = await this.db
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

  /* -------------------------------------------------------- unreconciled */

  /**
   * The split view PRD 04 asks for: what the bank showed that the books have
   * not explained, and what the books recorded that the bank has not shown.
   * Both halves are needed, because the reason cash ≠ bank is always one, the
   * other, or both.
   */
  async listUnreconciled(
    orgId: string,
    input: { bookId?: string; accountId: string; asOf: string; page?: number; pageSize?: number },
  ): Promise<UnreconciledView> {
    const asOf = assertIsoDate(input.asOf);
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 50));

    const profile = await this.requireProfileForAccount(orgId, input.accountId, input.bookId);

    const statementLines = await this.unmatchedStatementLines(orgId, { bankProfileId: profile.id, to: asOf });
    const glLines = await this.cashJournalLines(orgId, profile, { to: asOf, onlyUnexplained: true });

    const offset = (page - 1) * pageSize;
    return {
      bookId: profile.bookId,
      accountId: profile.accountId,
      bankProfileId: profile.id,
      currency: profile.currency,
      asOf,
      statementLines: statementLines.slice(offset, offset + pageSize),
      statementLinesTotalMinor: statementLines.reduce((a, l) => a + l.amountMinor, 0),
      glLines: glLines.slice(offset, offset + pageSize),
      glLinesTotalMinor: glLines.reduce((a, l) => a + l.amountMinor, 0),
      page,
      pageSize,
    };
  }

  /* -------------------------------------------------- shared query pieces */

  /**
   * GL movements on the cash account, in the bank's currency.
   *
   * A journal is *explained* when a match points at it directly, or when it is
   * the posting journal of a receipt or payment that is itself matched — the
   * receipt's cash line and the bank line are the same event seen twice, so
   * matching the receipt explains the GL line too.
   */
  async cashJournalLines(
    orgId: string,
    profile: BankAccountSummary,
    options: { from?: string; to: string; onlyUnexplained?: boolean; tx?: DbOrTx },
  ): Promise<UnreconciledGlLine[]> {
    const tx = options.tx ?? this.db;

    const matchedDirectly = exists(
      this.db.select({ one: sql`1` }).from(bankMatches).where(eq(bankMatches.journalId, glJournals.id)),
    );
    const matchedViaReceipt = exists(
      this.db
        .select({ one: sql`1` })
        .from(bankMatches)
        .innerJoin(arReceipts, eq(bankMatches.receiptId, arReceipts.id))
        .where(eq(arReceipts.postedJournalId, glJournals.id)),
    );
    const matchedViaPayment = exists(
      this.db
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
  async unmatchedStatementLines(
    orgId: string,
    options: { statementId?: string; bankProfileId?: string; to?: string; tx?: DbOrTx },
  ): Promise<UnreconciledStatementLine[]> {
    const tx = options.tx ?? this.db;

    const conditions = [
      eq(bankStatementLines.orgId, orgId),
      not(
        exists(
          this.db
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

  /* -------------------------------------------------------------- loaders */

  async requireStatementLine(
    orgId: string,
    statementLineId: string,
    tx: DbOrTx = this.db,
  ): Promise<StatementLineContext> {
    const [row] = await tx
      .select({
        id: bankStatementLines.id,
        statementId: bankStatementLines.statementId,
        lineNo: bankStatementLines.lineNo,
        valueDate: bankStatementLines.valueDate,
        amountMinor: bankStatementLines.amountMinor,
        description: bankStatementLines.description,
        bankReference: bankStatementLines.bankReference,
        bankProfileId: bankStatements.bankProfileId,
        periodStart: bankStatements.periodStart,
        periodEnd: bankStatements.periodEnd,
      })
      .from(bankStatementLines)
      .innerJoin(bankStatements, eq(bankStatementLines.statementId, bankStatements.id))
      .where(and(eq(bankStatementLines.orgId, orgId), eq(bankStatementLines.id, statementLineId)))
      .limit(1);

    if (!row) throw new NotFoundException("Bank statement line not found");

    const profile = await this.bankAccounts.get(orgId, row.bankProfileId, tx);
    return {
      id: row.id,
      statementId: row.statementId,
      lineNo: row.lineNo,
      valueDate: row.valueDate,
      amountMinor: Number(row.amountMinor),
      description: row.description,
      bankReference: row.bankReference,
      profile,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
    };
  }

  async requireProfileForAccount(
    orgId: string,
    accountId: string,
    bookId?: string,
  ): Promise<BankAccountSummary> {
    const conditions = [eq(bankProfiles.orgId, orgId), eq(bankProfiles.accountId, accountId)];
    if (bookId) conditions.push(eq(bankProfiles.bookId, bookId));

    const [row] = await this.db
      .select({ id: bankProfiles.id })
      .from(bankProfiles)
      .innerJoin(glAccounts, eq(bankProfiles.accountId, glAccounts.id))
      .where(and(...conditions, isNull(glAccounts.deletedAt)))
      .limit(1);

    if (!row) {
      throw new NotFoundException(
        "That GL account has no bank account attached, so there is nothing to reconcile against",
      );
    }
    return this.bankAccounts.get(orgId, row.id);
  }

  /**
   * Load the counterpart and express its amount the way the bank line is
   * expressed: signed, in the bank account's currency.
   */
  private async resolveCounterpart(
    orgId: string,
    line: StatementLineContext,
    counterpart: MatchCounterpart,
  ): Promise<{ amountMinor: number; label: string }> {
    if (counterpart.kind === "receipt") {
      const [receipt] = await this.db
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
      this.assertCounterpartFits(line, {
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
      const [payment] = await this.db
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
      this.assertCounterpartFits(line, {
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

    const [journal] = await this.db
      .select({ id: glJournals.id, bookId: glJournals.bookId, journalNumber: glJournals.journalNumber })
      .from(glJournals)
      .where(and(eq(glJournals.orgId, orgId), eq(glJournals.id, counterpart.id)))
      .limit(1);

    if (!journal) throw new NotFoundException("Journal not found");
    if (journal.bookId !== line.profile.bookId) throw new NotFoundException("Journal not found");

    const [movement] = await this.db
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

  private assertCounterpartFits(
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
}

/* ------------------------------------------------------------- text rules */

function normalizeReference(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 3),
  );
}

/** Sørensen–Dice over token sets: 2|A∩B| / (|A|+|B|). */
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return (2 * intersection) / (a.size + b.size);
}

function daysBetween(a: string, b: string): number {
  const left = Date.UTC(...isoParts(a));
  const right = Date.UTC(...isoParts(b));
  return Math.round((right - left) / 86_400_000);
}

function isoParts(value: string): [number, number, number] {
  const [y, m, d] = assertIsoDate(value).split("-").map(Number);
  return [y, m - 1, d];
}
