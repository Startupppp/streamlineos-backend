import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { glAccounts, glJournals } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { addDays, assertIsoDate } from "../kernel/fiscal-calendar";
import type { PostJournalLineCommand } from "../kernel/ledger.types";

export interface OpeningBalanceLine {
  accountId: string;
  /** Positive debits the account, negative credits it. Minor units. */
  amountMinor: number;
}

export interface OpeningBalancesInput {
  /** The day the books start. The journal is dated the day before it. */
  asOfDate: string;
  lines: OpeningBalanceLine[];
  memo?: string;
}

export interface OpeningBalancesPreview {
  asOfDate: string;
  journalDate: string;
  totalDebitMinor: number;
  totalCreditMinor: number;
  /** What the equity plug will absorb. Zero when the caller already balances. */
  differenceMinor: number;
  balancingAccountCode: string | null;
  currency: string;
  alreadyPosted: boolean;
}

/**
 * Opening balances (PRD 12 S1).
 *
 * A business that has been trading has balances before StreamlineOS existed:
 * cash in the bank, invoices already owed, a loan outstanding. Those arrive as
 * one journal dated the day *before* the books open, so the first real period
 * starts from a true position rather than from zero.
 *
 * The difference between the debits and credits a founder types is not an error
 * to reject — it is, by definition, the accumulated equity of the business up
 * to that day. It posts to retained earnings, which is what makes the whole
 * thing balance without asking someone who has never used accounting software
 * to work out their own equity.
 */
@Injectable()
export class OpeningBalancesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /** The idempotency key is fixed per book, so opening balances post once. */
  private keyFor(bookId: string): string {
    return `opening_balance:${bookId}:post`;
  }

  async preview(orgId: string, input: OpeningBalancesInput): Promise<OpeningBalancesPreview> {
    const book = await this.books.requireDefault(orgId);
    const { journalDate, totals, balancingAccountCode } = await this.compute(orgId, book, input);

    return {
      asOfDate: input.asOfDate,
      journalDate,
      totalDebitMinor: totals.debit,
      totalCreditMinor: totals.credit,
      differenceMinor: totals.debit - totals.credit,
      balancingAccountCode,
      currency: book.baseCurrency,
      alreadyPosted: await this.isPosted(orgId, book.id),
    };
  }

  /**
   * Post the opening journal. Re-running returns the original rather than
   * doubling the balances — the most damaging mistake available on this screen.
   */
  async post(orgId: string, userId: string, input: OpeningBalancesInput) {
    const book = await this.books.requireDefault(orgId);
    const { journalDate, lines } = await this.compute(orgId, book, input);

    const posted = await this.ledger.post(orgId, userId, {
      bookId: book.id,
      idempotencyKey: this.keyFor(book.id),
      journalDate,
      memo: input.memo ?? `Opening balances as at ${input.asOfDate}`,
      sourceType: "opening_balance",
      sourceId: book.id,
      lines,
    });

    if (!posted.replayed) {
      this.audit.log({
        action: "accounting.opening_balances.posted",
        userId,
        orgId,
        resourceType: "gl_journals",
        resourceId: posted.id,
        after: {
          asOfDate: input.asOfDate,
          lineCount: lines.length,
          totalMinor: posted.totalDebitMinor,
        },
      });
    }
    return posted;
  }

  async isPosted(orgId: string, bookId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: glJournals.id })
      .from(glJournals)
      .where(
        and(
          eq(glJournals.orgId, orgId),
          eq(glJournals.bookId, bookId),
          eq(glJournals.idempotencyKey, this.keyFor(bookId)),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /* ---------------------------------------------------------- internals */

  private async compute(
    orgId: string,
    book: { id: string; baseCurrency: string },
    input: OpeningBalancesInput,
  ) {
    if (!input.lines?.length) {
      throw new BadRequestException("Enter at least one opening balance");
    }

    // Dated the day before the books open, so the opening position sits outside
    // the first real period and never distorts its movement figures.
    const journalDate = addDays(assertIsoDate(input.asOfDate), -1);

    const wanted = [...new Set(input.lines.map((l) => l.accountId))];
    const accounts = await this.db
      .select({
        id: glAccounts.id,
        code: glAccounts.code,
        isHeader: glAccounts.isHeader,
        systemTag: glAccounts.systemTag,
      })
      .from(glAccounts)
      .where(
        and(
          eq(glAccounts.orgId, orgId),
          eq(glAccounts.bookId, book.id),
          isNull(glAccounts.deletedAt),
        ),
      );

    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const id of wanted) {
      const account = byId.get(id);
      if (!account) throw new BadRequestException(`Account ${id} is not in this book`);
      if (account.isHeader) {
        throw new BadRequestException(
          `${account.code} is a grouping account and cannot hold a balance`,
        );
      }
    }

    const lines: PostJournalLineCommand[] = [];
    let debit = 0;
    let credit = 0;

    for (const line of input.lines) {
      if (line.amountMinor === 0) continue;
      if (!Number.isInteger(line.amountMinor)) {
        throw new BadRequestException("Opening balances must be whole minor units");
      }
      if (line.amountMinor > 0) {
        debit += line.amountMinor;
        lines.push({ accountId: line.accountId, debitMinor: line.amountMinor });
      } else {
        credit += -line.amountMinor;
        lines.push({ accountId: line.accountId, creditMinor: -line.amountMinor });
      }
    }

    if (lines.length === 0) {
      throw new BadRequestException("Every opening balance was zero");
    }

    const difference = debit - credit;
    let balancingAccountCode: string | null = null;

    if (difference !== 0) {
      const retained = accounts.find((a) => a.systemTag === "retained_earnings");
      if (!retained) {
        throw new BadRequestException(
          "No retained earnings account is set up, so the opening balances cannot be balanced",
        );
      }
      balancingAccountCode = retained.code;
      // Debits exceeding credits means the business owns more than it owes —
      // that surplus is equity, so it credits retained earnings, and vice versa.
      lines.push(
        difference > 0
          ? { accountId: retained.id, creditMinor: difference }
          : { accountId: retained.id, debitMinor: -difference },
      );
    }

    return {
      journalDate,
      lines,
      totals: { debit, credit },
      balancingAccountCode,
    };
  }
}
