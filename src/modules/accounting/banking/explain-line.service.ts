import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import type { GlSystemTag } from "../../../db/schema";
import { BankAccountsService } from "./bank-accounts.service";
import { MatchingService, type RecordedMatch } from "./matching.service";

export interface ExplainLineInput {
  /** Where the other side of the money goes — a bank fee, interest, a refund. */
  contraAccountId?: string;
  /** Or name it by role, so a caller need not know an account id. */
  contraAccountTag?: GlSystemTag;
  memo?: string;
  description?: string;
}

export interface ExplainedLine {
  statementLineId: string;
  journalId: string;
  journalNumber: string;
  match: RecordedMatch;
}

/**
 * The shortcut for a bank line nothing in the books explains (PRD 04 S2).
 *
 * Bank charges, interest, a stray direct debit: there is no receipt or payment
 * to match against, so the line sits in the unreconciled list forever unless
 * someone posts a journal for it and then remembers to come back and match it.
 * Two steps, and the second is the one people skip — which is how a
 * reconciliation quietly stops reconciling.
 *
 * This does both in one transaction. Either the journal exists and the line is
 * matched, or neither happened.
 */
@Injectable()
export class ExplainLineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly bankAccounts: BankAccountsService,
    private readonly matching: MatchingService,
  ) {}

  async explain(
    orgId: string,
    userId: string | null,
    statementLineId: string,
    input: ExplainLineInput,
  ): Promise<ExplainedLine> {
    if (!input.contraAccountId && !input.contraAccountTag) {
      throw new BadRequestException("Say which account the other side of this belongs to");
    }

    const line = await this.matching.requireStatementLine(orgId, statementLineId);
    const book = await this.books.requireDefault(orgId);

    const contraAccountId =
      input.contraAccountId ??
      (await this.books.resolveAccountByTag(book.id, input.contraAccountTag as GlSystemTag));

    const cashAccountId = line.profile.accountId;
    const amount = Math.abs(line.amountMinor);
    if (amount === 0) throw new BadRequestException("A zero-amount line has nothing to explain");

    // A negative bank line is money leaving: credit the bank, debit whatever it
    // was spent on. Positive is the mirror.
    const moneyOut = line.amountMinor < 0;
    const description =
      input.description ?? line.description ?? line.bankReference ?? "Bank movement";

    const posted = await this.ledger.post(orgId, userId, {
      bookId: book.id,
      // One journal per statement line, whoever clicks and however often.
      idempotencyKey: `bank_fee:${statementLineId}:post`,
      journalDate: line.valueDate,
      memo: input.memo ?? `Bank line — ${description}`,
      sourceType: "bank_fee",
      sourceId: statementLineId,
      lines: moneyOut
        ? [
            { accountId: contraAccountId, debitMinor: amount, description },
            { accountId: cashAccountId, creditMinor: amount, description },
          ]
        : [
            { accountId: cashAccountId, debitMinor: amount, description },
            { accountId: contraAccountId, creditMinor: amount, description },
          ],
    });

    const match = await this.matching.match(orgId, userId, statementLineId, {
      kind: "journal",
      id: posted.id,
    });

    return {
      statementLineId,
      journalId: posted.id,
      journalNumber: posted.journalNumber,
      match,
    };
  }
}
