/**
 * The reconciliation proof (PRD 04 M6).
 *
 * "Reconciled" is not a flag somebody sets. It is an arithmetic statement that
 * either holds or does not:
 *
 * ```
 *   G  − Ugl  ==  S  − Ust
 * ```
 *
 * where `G` is the GL balance of the cash account at the statement's end date,
 * `S` is the statement's closing balance, `Ugl` is the movements the books
 * recorded that the bank has not shown, and `Ust` is the movements the bank
 * showed that the books have not recorded. Strip each side of what the other
 * side cannot see and the two must be the same number.
 *
 * Every term is returned, not just the verdict — the useful answer to "why does
 * cash not equal the bank?" is the list of items on each side, and a UI cannot
 * show that from a boolean.
 *
 * **Everything here is in the bank account's currency.** A USD account on INR
 * books reconciles against a USD statement; the functional figures are carried
 * alongside for context and never compared to the bank.
 *
 * Scope note on `Ugl`: it covers the statement's own window. Movements before
 * `periodStart` are already inside the statement's *opening* balance, so
 * counting them again would make every account with an opening balance fail
 * forever. What was carried in is reported instead as `openingVarianceMinor`
 * (books at period start, less the bank's stated opening) — a non-zero value
 * there is the honest answer to a proof that will not close.
 */
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { bankStatements } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { addDays } from "../kernel/fiscal-calendar";
import { money, toDecimalString } from "../kernel/money";
import { BankAccountsService } from "./bank-accounts.service";
import { MatchingService, type UnreconciledGlLine, type UnreconciledStatementLine } from "./matching.service";
import { StatementImportService } from "./statement-import.service";

export interface ReconciliationProof {
  statementId: string;
  bankProfileId: string;
  bookId: string;
  accountId: string;
  /** Every figure below is in this currency (PRD 04 M7). */
  currency: string;
  periodStart: string;
  periodEnd: string;

  /** `G` — the books' balance on the cash account at the statement end date. */
  glBalanceMinor: number;
  /** `S` — what the bank says the account closed at. */
  statementClosingMinor: number;
  /** `Ugl` — in the books, not on the statement. Uncleared cheques and the like. */
  unmatchedGlMinor: number;
  unmatchedGlLines: UnreconciledGlLine[];
  /** `Ust` — on the statement, not in the books. Fees, interest, direct debits. */
  unmatchedStatementMinor: number;
  unmatchedStatementLines: UnreconciledStatementLine[];

  /** `G − Ugl` and `S − Ust`; equal when the proof holds. */
  adjustedGlMinor: number;
  adjustedStatementMinor: number;
  differenceMinor: number;
  holds: boolean;

  /** Books at period start, less the bank's stated opening. Zero when nothing was carried in. */
  openingVarianceMinor: number;
  openingGlMinor: number;
  statementOpeningMinor: number;
  /** Unmatched GL movements dated before the window — stale items, for context. */
  priorUnmatchedGlMinor: number;

  /** The same GL balance in the book's own currency, for a reader who wants it. */
  functionalCurrency: string;
  glBalanceFunctionalMinor: number;

  /** One sentence a person can read. */
  explanation: string;

  reconciledAt: Date | null;
  reconciledBy: string | null;
}

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly bankAccounts: BankAccountsService,
    private readonly statements: StatementImportService,
    private readonly matching: MatchingService,
  ) {}

  /* ---------------------------------------------------------- the proof */

  async getRecProof(orgId: string, statementId: string): Promise<ReconciliationProof> {
    const statement = await this.statements.requireStatement(orgId, statementId);
    const profile = await this.bankAccounts.get(orgId, statement.bankProfileId);
    const book = await this.books.get(orgId, statement.bookId);

    const currency = profile.currency;
    const inBankCurrency = currency !== book.baseCurrency ? { currency } : {};
    const dayBeforeStart = addDays(statement.periodStart, -1);

    const [glBalanceMinor, openingGlMinor, glBalanceFunctionalMinor] = await Promise.all([
      this.bankAccounts.glBalanceMinor(profile.bookId, profile.accountId, statement.periodEnd, inBankCurrency),
      this.bankAccounts.glBalanceMinor(profile.bookId, profile.accountId, dayBeforeStart, inBankCurrency),
      this.bankAccounts.glBalanceMinor(profile.bookId, profile.accountId, statement.periodEnd),
    ]);

    const [unmatchedGlLines, priorUnmatchedGlLines, unmatchedStatementLines] = await Promise.all([
      this.matching.cashJournalLines(orgId, profile, {
        from: statement.periodStart,
        to: statement.periodEnd,
        onlyUnexplained: true,
      }),
      this.matching.cashJournalLines(orgId, profile, {
        to: dayBeforeStart,
        onlyUnexplained: true,
      }),
      this.matching.unmatchedStatementLines(orgId, { statementId: statement.id }),
    ]);

    const unmatchedGlMinor = totalOf(unmatchedGlLines);
    const priorUnmatchedGlMinor = totalOf(priorUnmatchedGlLines);
    const unmatchedStatementMinor = totalOf(unmatchedStatementLines);

    const adjustedGlMinor = glBalanceMinor - unmatchedGlMinor;
    const adjustedStatementMinor = statement.closingMinor - unmatchedStatementMinor;
    const differenceMinor = adjustedGlMinor - adjustedStatementMinor;
    const openingVarianceMinor = openingGlMinor - statement.openingMinor;

    return {
      statementId: statement.id,
      bankProfileId: profile.id,
      bookId: profile.bookId,
      accountId: profile.accountId,
      currency,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,

      glBalanceMinor,
      statementClosingMinor: statement.closingMinor,
      unmatchedGlMinor,
      unmatchedGlLines,
      unmatchedStatementMinor,
      unmatchedStatementLines,

      adjustedGlMinor,
      adjustedStatementMinor,
      differenceMinor,
      holds: differenceMinor === 0,

      openingVarianceMinor,
      openingGlMinor,
      statementOpeningMinor: statement.openingMinor,
      priorUnmatchedGlMinor,

      functionalCurrency: book.baseCurrency,
      glBalanceFunctionalMinor,

      explanation: this.explain({
        currency,
        differenceMinor,
        glBalanceMinor,
        statementClosing: statement.closingMinor,
        unmatchedGlMinor,
        unmatchedGlCount: unmatchedGlLines.length,
        unmatchedStatementMinor,
        unmatchedStatementCount: unmatchedStatementLines.length,
        openingVarianceMinor,
      }),

      reconciledAt: statement.reconciledAt,
      reconciledBy: statement.reconciledBy,
    };
  }

  /* ------------------------------------------------------ mark reconciled */

  /**
   * Stamp a statement reconciled — but only when the proof actually holds.
   *
   * This is the whole reason the proof exists: "reconciled" has to be earned by
   * arithmetic, not asserted by whoever got tired of looking at the screen.
   */
  async markReconciled(
    orgId: string,
    userId: string | null,
    statementId: string,
  ): Promise<ReconciliationProof> {
    const proof = await this.getRecProof(orgId, statementId);

    if (proof.reconciledAt) return proof;

    if (!proof.holds) {
      throw new ConflictException(
        `This statement cannot be marked reconciled: ${proof.explanation} ` +
          "Match or book the outstanding items first.",
      );
    }

    await this.db
      .update(bankStatements)
      .set({ reconciledAt: new Date(), reconciledBy: userId })
      .where(and(eq(bankStatements.orgId, orgId), eq(bankStatements.id, statementId)));

    return this.getRecProof(orgId, statementId);
  }

  /* ------------------------------------------------------------ narration */

  private explain(input: {
    currency: string;
    differenceMinor: number;
    glBalanceMinor: number;
    statementClosing: number;
    unmatchedGlMinor: number;
    unmatchedGlCount: number;
    unmatchedStatementMinor: number;
    unmatchedStatementCount: number;
    openingVarianceMinor: number;
  }): string {
    const show = (minor: number) => `${toDecimalString(money(minor, input.currency))} ${input.currency}`;
    const gap = input.glBalanceMinor - input.statementClosing;

    if (input.differenceMinor === 0) {
      if (gap === 0 && input.unmatchedGlCount === 0 && input.unmatchedStatementCount === 0) {
        return `The books and the bank both say ${show(input.glBalanceMinor)}, with nothing outstanding.`;
      }
      return (
        `The books say ${show(input.glBalanceMinor)} and the bank says ${show(input.statementClosing)}; ` +
        `the ${show(gap)} between them is fully explained by ` +
        `${input.unmatchedGlCount} book movement(s) the bank has not shown (${show(input.unmatchedGlMinor)}) ` +
        `and ${input.unmatchedStatementCount} bank movement(s) the books have not recorded ` +
        `(${show(input.unmatchedStatementMinor)}).`
      );
    }

    const carried =
      input.openingVarianceMinor !== 0
        ? ` ${show(input.openingVarianceMinor)} of it was already there at the start of the period — ` +
          "the books and the bank disagreed before this statement began."
        : "";

    return (
      `${show(input.differenceMinor)} is unexplained. The books say ${show(input.glBalanceMinor)} ` +
      `less ${show(input.unmatchedGlMinor)} outstanding; the bank says ${show(input.statementClosing)} ` +
      `less ${show(input.unmatchedStatementMinor)} unrecorded.${carried}`
    );
  }
}

function totalOf(lines: readonly { amountMinor: number }[]): number {
  return lines.reduce((total, line) => total + line.amountMinor, 0);
}
