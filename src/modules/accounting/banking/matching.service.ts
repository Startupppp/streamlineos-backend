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
 * and the match insert (lib/match-writes.ts) catches `23505` and turns it into a
 * 409 that names which of them fired. The database is the enforcement; the code
 * is the message.
 *
 * Amounts are compared in the **bank account's currency**, never the functional
 * one. A USD account on INR books is reconciled against a USD statement; the
 * INR figures on the same journal lines are a different question.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { bankProfiles, bankStatementLines, bankStatements, glAccounts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../kernel/sequence.service";
import { addDays, assertIsoDate } from "../kernel/fiscal-calendar";
import { money, toDecimalString } from "../kernel/money";
import { BankAccountsService, type BankAccountSummary } from "./bank-accounts.service";
import { journalSuggestions, paymentCandidates, receiptCandidates } from "./lib/match-candidates";
import { resolveCounterpart } from "./lib/match-counterparts";
import { scoreCandidate } from "./lib/match-scoring";
import { recordMatch, removeMatch } from "./lib/match-writes";
import { loadCashJournalLines, loadUnmatchedStatementLines } from "./lib/unreconciled-reads";
import type {
  MatchCounterpart,
  MatchSuggestion,
  RecordedMatch,
  StatementLineContext,
  UnreconciledGlLine,
  UnreconciledStatementLine,
  UnreconciledView,
} from "./matching.types";

/*
  The flow stays here; the pieces are in lib/: candidate reads, scoring, the
  counterpart checks, the two writes on bank_matches and the unreconciled reads.
*/
export type {
  MatchCounterpart,
  MatchKind,
  MatchSuggestion,
  RecordedMatch,
  StatementLineContext,
  UnreconciledGlLine,
  UnreconciledStatementLine,
  UnreconciledView,
} from "./matching.types";

/** PRD 04: candidates are within three days either side of the bank's value date. */
export const MATCH_DATE_WINDOW_DAYS = 3;

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
      candidates.push(...(await receiptCandidates(this.db, orgId, line, absolute, from, to)));
    } else {
      candidates.push(...(await paymentCandidates(this.db, orgId, line, absolute, from, to)));
    }
    candidates.push(...(await this.journalCandidates(orgId, line, from, to)));

    for (const candidate of candidates) {
      const { score, reasons } = scoreCandidate(line, candidate);
      candidate.score = score;
      candidate.reasons = reasons;
    }

    candidates.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
    return { line, suggestions: candidates.slice(0, limit) };
  }

  /** Journals on the cash account that net to the bank line's amount. */
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
    return journalSuggestions(line, items);
  }

  /* --------------------------------------------------------------- match */

  async match(
    orgId: string,
    userId: string | null,
    statementLineId: string,
    counterpart: MatchCounterpart,
  ): Promise<RecordedMatch> {
    const line = await this.requireStatementLine(orgId, statementLineId);
    const resolved = await resolveCounterpart(this.db, orgId, line, counterpart);

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

    return recordMatch(this.db, orgId, userId, line, counterpart);
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
    return removeMatch(this.db, orgId, statementLineId);
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
   * GL movements on the cash account, in the bank's currency, and whether a
   * match explains each; the rules are in lib/unreconciled-reads.ts.
   */
  async cashJournalLines(
    orgId: string,
    profile: BankAccountSummary,
    options: { from?: string; to: string; onlyUnexplained?: boolean; tx?: DbOrTx },
  ): Promise<UnreconciledGlLine[]> {
    return loadCashJournalLines(this.db, orgId, profile, options);
  }

  /** Statement lines with no match, either for one statement or a whole account. */
  async unmatchedStatementLines(
    orgId: string,
    options: { statementId?: string; bankProfileId?: string; to?: string; tx?: DbOrTx },
  ): Promise<UnreconciledStatementLine[]> {
    return loadUnmatchedStatementLines(this.db, orgId, options);
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
}
