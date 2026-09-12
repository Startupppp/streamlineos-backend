import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { glAccounts } from "../../../db/schema";
import { BooksService } from "../../accounting/kernel/books.service";
import { PeriodsService } from "../../accounting/kernel/periods.service";
import type { DbOrTx } from "../../accounting/kernel/sequence.service";
import { PostingCommandService } from "../../accounting/adapters/posting-command.service";
import {
  AdapterRejection,
  type PostingCommandLine,
} from "../../accounting/adapters/posting-command.types";
import {
  INVENTORY_JOURNAL_PURPOSES,
  INVENTORY_PURPOSE_TAG,
  toMinorUnits,
  type InventoryAccountCodes,
  type InventoryJournalDraft,
  type InventoryJournalLine,
} from "./lib/journal-vocabulary";

/**
 * The journal vocabulary (purposes, the role each resolves to, the draft
 * shapes and exact minor-unit conversion) lives in lib/journal-vocabulary.ts.
 * Re-exported so this file stays the one entry point its importers use.
 */
export {
  INVENTORY_JOURNAL_PURPOSES,
  INVENTORY_PURPOSE_TAG,
  minorUnitsToDecimal,
  toMinorUnits,
} from "./lib/journal-vocabulary";
export type {
  InventoryAccountCodes,
  InventoryJournalDraft,
  InventoryJournalLine,
  InventoryJournalPurpose,
  InventoryJournalSource,
} from "./lib/journal-vocabulary";

/**
 * The stock-side period guard: refuse a movement dated into a LOCKED period of
 * the organisation's default book.
 *
 * One function, used by both ways into the engine: `StockEngineService` for a
 * single command and `StockEngineBatchService`, through `assertOpen`, for a
 * batch. Before the rewrite the batch path asked the legacy
 * `accounting_periods` table and refused CLOSED periods as well. The kernel has
 * only OPEN and LOCKED, so the two paths now give the same answer.
 *
 * Accounting is opt-in: an organisation with no book is unguarded, and so is a
 * date no period covers. Posting itself still refuses a journal dated into a
 * locked period; this guard only stops the stock from moving first.
 */
export async function assertStockPeriodOpen(
  books: Pick<BooksService, "findDefault">,
  periods: Pick<PeriodsService, "periodForDate">,
  orgId: string,
  postingDate: string,
): Promise<void> {
  const book = await books.findDefault(orgId);
  if (!book) return;
  const period = await periods.periodForDate(book.id, postingDate);
  if (period?.status === "LOCKED") {
    throw new ConflictException(
      `Accounting period ${period.name} is locked. Cannot post stock into a locked period.`,
    );
  }
}

/**
 * Everything inventory asks of accounting that is not a stock movement's own
 * posting (`StockMovementBridgeService` owns those): the period guard for the
 * batch path, the receipt and landed-cost journals, and the answers the
 * valuation and reconciliation reports need.
 *
 * On the kernel. `LedgerService` is the only writer of the ledger and
 * `PostingCommandService` is the only way to reach it, so this class resolves
 * nothing to an account itself. It translates purposes to roles and decimals to
 * minor units, and hands over the caller's own transaction.
 *
 * FAILS CLOSED, which is a deliberate change from what this class used to do.
 * The legacy bridge probed tables with `to_regclass`, and it warned and skipped
 * when accounting was absent or the chart lacked an account code, so goods
 * moved and no journal was written. The kernel's contract
 * (`docs/inventory-gl-contract.md` §4, ACC-06) is the opposite. An organisation
 * with accounting enabled and a role unmapped, or a journal dated into a
 * locked period, has the stock command refused, and the caller's transaction
 * rolls back with it. Only `BOOK_NOT_ENABLED`, meaning the organisation never
 * turned accounting on, is a skip. The `gl_*` tables are part of the migration
 * chain, so there is nothing to probe for any more.
 */
@Injectable()
export class InventoryAccountingBridge {
  private readonly logger = new Logger(InventoryAccountingBridge.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly periods: PeriodsService,
    private readonly posting: PostingCommandService,
  ) {}

  /** The organisation's default book, or `null` when it has not enabled accounting. */
  async defaultBookId(orgId: string, tx: DbOrTx = this.db): Promise<string | null> {
    const book = await this.books.findDefault(orgId, tx);
    return book?.id ?? null;
  }

  /**
   * D6: whether this organisation's stock movements are expected to produce
   * journals. On the kernel that means whether it keeps a book, not whether a
   * table exists in the database.
   */
  async hasJournals(orgId: string): Promise<boolean> {
    return (await this.defaultBookId(orgId)) !== null;
  }

  /**
   * D5: whether accounting periods exist to quote a valuation against. Periods
   * live in the book, and enabling accounting always opens the current fiscal
   * year, so this is the same fact as `hasJournals`. The two names are kept
   * because they are different questions to the callers asking them.
   */
  async hasPeriods(orgId: string): Promise<boolean> {
    return (await this.defaultBookId(orgId)) !== null;
  }

  /**
   * INV-09: the account code each purpose posts to for this organisation, read
   * from `gl_accounts` through the role it is tagged with.
   *
   * There is no mapping table any more: the tag on the account IS the mapping,
   * and `uniq_gl_accounts_book_system_tag` allows one account per role per
   * book, which is why the read is bounded by the number of roles. The report
   * that calls this reads through the same tags posting resolves, so the report
   * and the ledger look at the same chart.
   */
  async resolveAccountCodes(orgId: string, tx: DbOrTx = this.db): Promise<InventoryAccountCodes> {
    const codes = Object.fromEntries(
      INVENTORY_JOURNAL_PURPOSES.map((purpose) => [purpose, null]),
    ) as InventoryAccountCodes;

    const bookId = await this.defaultBookId(orgId, tx);
    if (bookId === null) return codes;

    const tags = [...new Set(Object.values(INVENTORY_PURPOSE_TAG))];
    const rows = await tx
      .select({ code: glAccounts.code, systemTag: glAccounts.systemTag })
      .from(glAccounts)
      .where(
        and(
          eq(glAccounts.orgId, orgId),
          eq(glAccounts.bookId, bookId),
          eq(glAccounts.isActive, true),
          isNull(glAccounts.deletedAt),
          inArray(glAccounts.systemTag, tags),
        ),
      )
      .limit(tags.length);

    const byTag = new Map(rows.map((row) => [row.systemTag, row.code]));
    for (const purpose of INVENTORY_JOURNAL_PURPOSES) {
      codes[purpose] = byTag.get(INVENTORY_PURPOSE_TAG[purpose]) ?? null;
    }
    return codes;
  }

  /** Refuses a movement into a locked period of the organisation's book. */
  async assertOpen(orgId: string, postingDate: string): Promise<void> {
    await assertStockPeriodOpen(this.books, this.periods, orgId, postingDate);
  }

  /**
   * Post the journal for a stock document, on the caller's transaction.
   *
   * `tx` is required, not defaulted. The goods-receipt post calls this inside
   * the receipt's own transaction, and landed cost inside the voucher's. A call
   * that fell back to `this.db` would still work under the request interceptor,
   * but only because it borrowed a guarantee this seam is meant to make itself
   * (ACC-05).
   *
   * Every rejection except `BOOK_NOT_ENABLED` is rethrown, so the caller's
   * stock change rolls back with it. `PostingCommandService` has already left
   * an audit row for the refusal outside the transaction.
   */
  async postJournalEntry(draft: InventoryJournalDraft, tx: DbOrTx): Promise<void> {
    const lines = draft.lines.flatMap(toCommandLine);
    if (lines.length === 0) return;

    try {
      await this.posting.submit(
        draft.orgId,
        draft.createdBy,
        {
          sourceType: "stock_move",
          sourceId: draft.sourceId,
          purpose: draft.sourceEvent,
          journalDate: draft.entryDate,
          memo: draft.description,
          lines,
        },
        tx,
      );
    } catch (error) {
      if (error instanceof AdapterRejection && error.code === "BOOK_NOT_ENABLED") {
        this.logger.debug(
          `Accounting is not enabled for org ${draft.orgId}; "${draft.description}" was not posted`,
        );
        return;
      }
      throw error;
    }
  }
}

/**
 * One draft line as a posting-command line: purpose to role, decimal to minor
 * units. A line that rounds to nothing is dropped rather than posted as a zero.
 */
function toCommandLine(line: InventoryJournalLine): PostingCommandLine[] {
  const debitMinor = line.debit === undefined ? 0 : toMinorUnits(line.debit);
  const creditMinor = line.credit === undefined ? 0 : toMinorUnits(line.credit);
  if (debitMinor > 0 && creditMinor > 0) {
    throw new Error(`A journal line is a debit or a credit, not both (${line.purpose})`);
  }
  if (debitMinor === 0 && creditMinor === 0) return [];
  return [
    {
      accountTag: INVENTORY_PURPOSE_TAG[line.purpose],
      ...(debitMinor > 0 ? { debitMinor } : { creditMinor }),
      description: line.description,
    },
  ];
}
