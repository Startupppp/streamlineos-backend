import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, gte, sql } from "drizzle-orm";
import {
  glAccounts,
  glBookCurrencies,
  glBooks,
  glFiscalYears,
  glJournalLines,
  glJournals,
  glPeriods,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { PackRegistry } from "../packs/pack.registry";
import { assertIsoDate } from "./fiscal-calendar";
import { assertCurrencyCode, assertSafeMinor } from "./money";
import { isUniqueViolation } from "./pg-errors";
import { SequenceService, type DbOrTx } from "./sequence.service";
import {
  LedgerRejection,
  type PostJournalCommand,
  type PostJournalLineCommand,
  type PostedJournal,
  type PostedJournalLine,
  type ReverseJournalCommand,
} from "./ledger.types";

/** A line after defaults are applied and every field is known. */
interface NormalizedLine {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  txnCurrency: string;
  txnAmountMinor: number;
  functionalCurrency: string;
  functionalAmountMinor: number;
  fxRate: string;
  fxRateId: string | null;
  partyId: string | null;
  taxCodeId: string | null;
  taxComponent: string | null;
  dimensionBranchId: string | null;
  dimensionProjectId: number | null;
  dimensionCostCenterId: string | null;
  dimensionValues: Record<string, string> | null;
  description: string | null;
}

/**
 * The ledger kernel.
 *
 * Everything the product knows about money arrives here as a `PostJournal` and
 * leaves as immutable rows. Nothing else in the codebase writes `gl_journals` or
 * `gl_journal_lines` — that is the invariant the rest of accounting rests on.
 *
 * Corrections are reversing journals. There is deliberately no `update` and no
 * `delete` on this class.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sequences: SequenceService,
    private readonly packs: PackRegistry,
  ) {}

  /* ------------------------------------------------------------- posting */

  /**
   * Post a balanced journal, or reject and write nothing.
   *
   * Pass `tx` when a document is posting as part of its own transaction — the
   * journal and the document then commit or roll back together.
   */
  async post(
    orgId: string,
    userId: string | null,
    command: PostJournalCommand,
    tx?: DbOrTx,
  ): Promise<PostedJournal> {
    if (tx) return this.postWithin(orgId, userId, command, tx);

    try {
      return await this.db.transaction((t) => this.postWithin(orgId, userId, command, t));
    } catch (error) {
      /**
       * Lost the insert race on `(book_id, idempotency_key)`.
       *
       * The recovery has to happen out here, not inside the transaction that
       * hit the violation: Postgres marks that transaction aborted, so every
       * subsequent statement in it fails with 25P02 and the winner could never
       * be read. On a fresh connection the winner has committed and is
       * readable, which is what makes a double-click idempotent rather than a
       * 500.
       */
      if (isUniqueViolation(error, "uniq_gl_journals_book_idempotency")) {
        const winner = await this.findByIdempotencyKey(
          orgId,
          command.bookId,
          command.idempotencyKey,
          this.db,
        );
        if (winner) return { ...winner, replayed: true };
      }
      throw error;
    }
  }

  private async postWithin(
    orgId: string,
    userId: string | null,
    command: PostJournalCommand,
    tx: DbOrTx,
  ): Promise<PostedJournal> {
    const journalDate = this.validateDate(command.journalDate);

    if (!command.idempotencyKey?.trim()) {
      throw new LedgerRejection("IDEMPOTENCY_CONFLICT", "An idempotency key is required");
    }

    // An idempotent replay must not do any of the work below, so check first.
    const replay = await this.findByIdempotencyKey(orgId, command.bookId, command.idempotencyKey, tx);
    if (replay) return { ...replay, replayed: true };

    const book = await this.loadBook(orgId, command.bookId, tx);
    const lines = this.normalizeLines(command.lines, book.baseCurrency);
    this.assertBalanced(lines);

    const period = await this.resolvePeriod(command.bookId, journalDate, tx);
    await this.assertCurrenciesAllowed(command.bookId, lines, tx);
    await this.assertAccountsPostable(command.bookId, lines, tx);

    const fiscalYear = await this.loadFiscalYear(period.fiscalYearId, tx);
    const pack = this.packs.get(book.localizationPack);
    const journalNumber = await this.sequences.allocate(
      {
        orgId,
        bookId: command.bookId,
        kind: "journal",
        series: pack.documentSeries.journal,
        fiscalYear: { id: fiscalYear.id, name: fiscalYear.name },
      },
      tx,
    );

    let journalId: string;
    try {
      /**
       * The insert runs inside a SAVEPOINT (drizzle renders a nested
       * `transaction()` as one). A unique violation would otherwise abort the
       * whole enclosing transaction, and a document posting through us would
       * lose its own work as well as the ability to read the winner back.
       */
      journalId = await tx.transaction(async (savepoint) => {
        const [inserted] = await savepoint
          .insert(glJournals)
          .values({
            orgId,
            bookId: command.bookId,
            periodId: period.id,
            journalNumber,
            journalDate,
            memo: command.memo ?? null,
            sourceType: command.sourceType,
            sourceId: command.sourceId ?? null,
            idempotencyKey: command.idempotencyKey,
            postedByUserId: userId,
          })
          .returning({ id: glJournals.id });
        if (!inserted) throw new Error("Journal insert returned no row");
        return inserted.id;
      });
    } catch (error) {
      // Lost a race against a concurrent post of the same key. The savepoint
      // rolled back, so this transaction is still usable and the winner — if it
      // has committed — is readable. If it has not committed yet, rethrow and
      // let `post` retry the read on a fresh connection.
      if (isUniqueViolation(error, "uniq_gl_journals_book_idempotency")) {
        const winner = await this.findByIdempotencyKey(
          orgId,
          command.bookId,
          command.idempotencyKey,
          tx,
        );
        if (winner) return { ...winner, replayed: true };
      }
      throw error;
    }

    await tx.insert(glJournalLines).values(
      lines.map((line, index) => ({
        orgId,
        bookId: command.bookId,
        journalId,
        lineNo: index + 1,
        ...line,
      })),
    );

    await OutboxWriter.emit(tx, {
      eventId: randomUUID(),
      organizationId: orgId,
      aggregateType: "gl_journal",
      aggregateId: journalId,
      aggregateVersion: Date.now(),
      eventType: "accounting.journal.posted",
      payload: {
        organization_id: orgId,
        book_id: command.bookId,
        journal_id: journalId,
        journal_number: journalNumber,
        journal_date: journalDate,
        source_type: command.sourceType,
        source_id: command.sourceId ?? null,
        actor_user_id: userId,
      },
      occurredAt: new Date(),
    });

    const posted = await this.loadJournal(orgId, journalId, tx);
    if (!posted) throw new Error(`Journal ${journalId} vanished immediately after insert`);
    return posted;
  }

  /* ----------------------------------------------------------- reversing */

  /**
   * Post the mirror of an existing journal and link the two.
   *
   * The original is never rewritten. The only column touched on it is
   * `reversed_by_journal_id`, which is a link rather than a business field, and
   * whose unique index is what makes "reversed at most once" true (invariant 5).
   *
   * A reversal into a locked period is **rejected** rather than silently
   * date-shifted — PRD 01 asks for one behaviour, tested; this is it.
   */
  async reverse(
    orgId: string,
    userId: string | null,
    command: ReverseJournalCommand,
    tx?: DbOrTx,
  ): Promise<PostedJournal> {
    if (tx) return this.reverseWithin(orgId, userId, command, tx);
    return this.db.transaction((t) => this.reverseWithin(orgId, userId, command, t));
  }

  private async reverseWithin(
    orgId: string,
    userId: string | null,
    command: ReverseJournalCommand,
    tx: DbOrTx,
  ): Promise<PostedJournal> {
    const replay = await this.findByIdempotencyKey(orgId, command.bookId, command.idempotencyKey, tx);
    if (replay) return { ...replay, replayed: true };

    const original = await this.loadJournal(orgId, command.journalId, tx);
    if (!original || original.bookId !== command.bookId) {
      throw new LedgerRejection("JOURNAL_NOT_FOUND", `Journal ${command.journalId} was not found`);
    }
    if (original.reversedByJournalId) {
      throw new LedgerRejection(
        "ALREADY_REVERSED",
        `Journal ${original.journalNumber} was already reversed`,
        undefined,
        { reversedByJournalId: original.reversedByJournalId },
      );
    }

    const reversal = await this.postWithin(
      orgId,
      userId,
      {
        bookId: command.bookId,
        idempotencyKey: command.idempotencyKey,
        journalDate: command.journalDate ?? original.journalDate,
        memo: command.memo ?? `Reversal of ${original.journalNumber}`,
        sourceType: original.sourceType,
        sourceId: original.sourceId ?? undefined,
        // Swap the sides; everything else about the line is carried over.
        lines: original.lines.map((line) => ({
          accountId: line.accountId,
          debitMinor: line.creditMinor,
          creditMinor: line.debitMinor,
          txnCurrency: line.txnCurrency,
          txnAmountMinor: line.txnAmountMinor,
          functionalAmountMinor: line.functionalAmountMinor,
          fxRate: line.fxRate,
          description: `Reverses ${original.journalNumber}`,
        })),
      },
      tx,
    );

    await tx
      .update(glJournals)
      .set({ reversesJournalId: original.id })
      .where(and(eq(glJournals.orgId, orgId), eq(glJournals.id, reversal.id)));

    // Conditional on still being null, so two concurrent reversals cannot both
    // claim the original even if they somehow passed the check above.
    const claimed = await tx
      .update(glJournals)
      .set({ reversedByJournalId: reversal.id })
      .where(
        and(
          eq(glJournals.orgId, orgId),
          eq(glJournals.id, original.id),
          isNull(glJournals.reversedByJournalId),
        ),
      )
      .returning({ id: glJournals.id });

    if (claimed.length === 0) {
      throw new LedgerRejection(
        "ALREADY_REVERSED",
        `Journal ${original.journalNumber} was reversed concurrently`,
      );
    }

    return { ...reversal, reversesJournalId: original.id };
  }

  /* ---------------------------------------------------------- validation */

  private validateDate(value: string): string {
    try {
      return assertIsoDate(value);
    } catch {
      throw new LedgerRejection("PERIOD_NOT_FOUND", `Invalid journal date: ${value}`);
    }
  }

  /**
   * Fill defaults and reject anything structurally wrong, before a single row
   * is read. Pure enough to unit-test without a database.
   */
  private normalizeLines(
    lines: readonly PostJournalLineCommand[],
    baseCurrency: string,
  ): NormalizedLine[] {
    if (!lines || lines.length === 0) {
      throw new LedgerRejection("EMPTY_JOURNAL", "A journal needs at least one line");
    }

    return lines.map((line, index) => {
      const debitMinor = line.debitMinor ?? 0;
      const creditMinor = line.creditMinor ?? 0;

      if (debitMinor < 0 || creditMinor < 0) {
        throw new LedgerRejection(
          "LINE_AMOUNT_INVALID",
          `Line ${index + 1}: amounts cannot be negative`,
          index,
        );
      }
      if ((debitMinor > 0) === (creditMinor > 0)) {
        throw new LedgerRejection(
          "LINE_SIDE_INVALID",
          `Line ${index + 1}: exactly one of debit or credit must be greater than zero`,
          index,
        );
      }
      assertSafeMinor(debitMinor);
      assertSafeMinor(creditMinor);

      const functionalAmountMinor = Math.max(debitMinor, creditMinor);
      const txnCurrency = assertCurrencyCode(line.txnCurrency ?? baseCurrency);
      const txnAmountMinor = line.txnAmountMinor ?? functionalAmountMinor;

      if (!Number.isInteger(txnAmountMinor) || txnAmountMinor <= 0) {
        throw new LedgerRejection(
          "LINE_AMOUNT_INVALID",
          `Line ${index + 1}: transaction amount must be a positive whole number of minor units`,
          index,
        );
      }

      if (
        line.functionalAmountMinor !== undefined &&
        line.functionalAmountMinor !== functionalAmountMinor
      ) {
        throw new LedgerRejection(
          "LINE_AMOUNT_INVALID",
          `Line ${index + 1}: functional amount ${line.functionalAmountMinor} does not match the ` +
            `${debitMinor > 0 ? "debit" : "credit"} of ${functionalAmountMinor}`,
          index,
        );
      }

      const sameCurrency = txnCurrency === baseCurrency;
      const fxRate = line.fxRate ?? "1";
      if (sameCurrency) {
        if (Number(fxRate) !== 1) {
          throw new LedgerRejection(
            "FX_RATE_INVALID",
            `Line ${index + 1}: a ${baseCurrency} line must carry rate 1, got ${fxRate}`,
            index,
          );
        }
        if (txnAmountMinor !== functionalAmountMinor) {
          throw new LedgerRejection(
            "LINE_AMOUNT_INVALID",
            `Line ${index + 1}: a ${baseCurrency} line must have equal transaction and functional amounts`,
            index,
          );
        }
      } else if (!(Number(fxRate) > 0)) {
        // The kernel does not fetch or recompute FX (S4) — it only insists the
        // document did the conversion and showed its working.
        throw new LedgerRejection(
          "FX_RATE_INVALID",
          `Line ${index + 1}: a ${txnCurrency} line on ${baseCurrency} books needs a positive FX rate`,
          index,
        );
      }

      return {
        accountId: line.accountId,
        debitMinor,
        creditMinor,
        txnCurrency,
        txnAmountMinor,
        functionalCurrency: baseCurrency,
        functionalAmountMinor,
        fxRate,
        fxRateId: line.fxRateId ?? null,
        partyId: line.partyId ?? null,
        taxCodeId: line.taxCodeId ?? null,
        taxComponent: line.taxComponent ?? null,
        dimensionBranchId: line.dimensionBranchId ?? null,
        dimensionProjectId: line.dimensionProjectId ?? null,
        dimensionCostCenterId: line.dimensionCostCenterId ?? null,
        dimensionValues: line.dimensionValues ?? null,
        description: line.description ?? null,
      };
    });
  }

  /** Zero tolerance. Rounding belongs to the document layer, not here (M2). */
  private assertBalanced(lines: readonly NormalizedLine[]): void {
    let debit = 0;
    let credit = 0;
    for (const line of lines) {
      debit += line.debitMinor;
      credit += line.creditMinor;
    }
    if (debit !== credit) {
      throw new LedgerRejection(
        "UNBALANCED",
        `Journal does not balance: debits ${debit}, credits ${credit}, difference ${debit - credit}`,
        undefined,
        { totalDebitMinor: debit, totalCreditMinor: credit },
      );
    }
  }

  private async loadBook(orgId: string, bookId: string, tx: DbOrTx) {
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
  private async resolvePeriod(bookId: string, journalDate: string, tx: DbOrTx) {
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

  private async loadFiscalYear(fiscalYearId: string, tx: DbOrTx) {
    const [fy] = await tx
      .select({ id: glFiscalYears.id, name: glFiscalYears.name })
      .from(glFiscalYears)
      .where(eq(glFiscalYears.id, fiscalYearId))
      .limit(1);
    if (!fy) throw new LedgerRejection("PERIOD_NOT_FOUND", "The period's fiscal year is missing");
    return fy;
  }

  /**
   * Every account must belong to this book, be a posting account, be active,
   * and accept the line's currency. Scoping the query by `bookId` is also what
   * makes an account borrowed from another org resolve to "not found" (test 9).
   */
  /**
   * Every transaction currency must be one the book has enabled (PRD 11 M4).
   *
   * Without this a typo posts a journal in a currency the business does not
   * trade in, and the first anyone knows about the phantom exposure is a
   * balance sheet that will not explain itself. Enabling a currency is one
   * deliberate action; posting in one should not be an accident.
   */
  private async assertCurrenciesAllowed(
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

  private async assertAccountsPostable(
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

  /* -------------------------------------------------------------- reads */

  private async findByIdempotencyKey(
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
    return row ? this.loadJournal(orgId, row.id, tx) : null;
  }

  /** Header plus lines, joined to accounts so a caller never re-queries. */
  async loadJournal(
    orgId: string,
    journalId: string,
    tx: DbOrTx = this.db,
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
  async trialBalance(
    orgId: string,
    bookId: string,
    asOf: string,
    tx: DbOrTx = this.db,
  ): Promise<
    Array<{
      accountId: string;
      code: string;
      name: string;
      accountType: string;
      debitMinor: number;
      creditMinor: number;
      balanceMinor: number;
    }>
  > {
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
}
