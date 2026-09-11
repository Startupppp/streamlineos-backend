import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { glAccounts, type GlSystemTag } from "../../../db/schema";
import { BooksService } from "../../accounting/kernel/books.service";
import { PeriodsService } from "../../accounting/kernel/periods.service";
import { assertSafeMinor } from "../../accounting/kernel/money";
import type { DbOrTx } from "../../accounting/kernel/sequence.service";
import { PostingCommandService } from "../../accounting/adapters/posting-command.service";
import {
  AdapterRejection,
  type PostingCommandLine,
} from "../../accounting/adapters/posting-command.types";

/**
 * INV-09 — every purpose inventory names when it hands the ledger a journal, and
 * nothing else.
 *
 * Purposes are inventory's vocabulary. Since the accounting rewrite they are
 * resolved to a `gl_system_tag` (below) and the kernel resolves the tag to an
 * account in the organisation's default book, so nothing in inventory names an
 * account id or an account code, and a tenant that renumbers its chart keeps
 * posting to the same roles.
 *
 * `AR` and `SALES_INCOME` are listed because the sales-order invoice was once
 * posted through this list; the kernel-era invoice posts through
 * `PostingCommandService` directly with the same two roles.
 */
export const INVENTORY_JOURNAL_PURPOSES = [
  "INVENTORY_ASSET",
  "INVENTORY_COGS",
  "INVENTORY_GRNI",
  "AP",
  "AR",
  "SALES_INCOME",
] as const;

export type InventoryJournalPurpose = (typeof INVENTORY_JOURNAL_PURPOSES)[number];

/**
 * The account role each purpose posts to.
 *
 * The one row that is an accounting decision rather than a translation is
 * `INVENTORY_GRNI`. TODO(ACC-03): a goods receipt should credit `grni`, and the
 * purchase bill should move it to `ap_control` (`docs/inventory-gl-contract.md`
 * §2.2, migration 0672). It credits `ap_control` here because the one-shot
 * receive in `grn-receive.service.ts` credits `ap_control`, and both receipt
 * paths post under the same key `stock_move:{grnId}:receive`. Two paths that
 * booked one event to two different accounts would be worse than either
 * answer. Change both together, and only once the bill drains GRNI; until then
 * vendor returns debit `grni`, so that account can run negative.
 */
export const INVENTORY_PURPOSE_TAG: Readonly<Record<InventoryJournalPurpose, GlSystemTag>> = {
  INVENTORY_ASSET: "inventory",
  INVENTORY_COGS: "cogs",
  INVENTORY_GRNI: "ap_control",
  AP: "ap_control",
  AR: "ar_control",
  SALES_INCOME: "sales",
};

/**
 * The code of the account filling each purpose's role in the organisation's
 * default book. `null` when the organisation keeps no book, or when no active
 * account carries the role. A null is exactly the case in which a post would
 * be refused with `UNKNOWN_ACCOUNT_TAG`.
 */
export type InventoryAccountCodes = Record<InventoryJournalPurpose, string | null>;

/**
 * Which stock document a journal values, and the posting purpose it is keyed
 * under. The kernel's idempotency key is `stock_move:{sourceId}:{sourceEvent}`.
 *
 * A closed set, for the reason `StockDocumentKind` is one: ids come from
 * different tables, so the purpose is what keeps two documents out of one key.
 *
 *   - `receive` is shared on purpose with `grn-receive.service.ts`. Both are
 *     "this GRN was posted", so one GRN can only ever produce one receipt
 *     journal, whichever path posted it.
 *   - `landed_cost` has no kernel document kind at all. See
 *     `landed-cost/lib/landed-cost-journal.ts` for the open decision.
 */
export type InventoryJournalSource =
  | { sourceType: "inv_grn"; sourceEvent: "receive" }
  | { sourceType: "inv_landed_cost"; sourceEvent: "landed_cost" };

/**
 * One line, named by purpose. Amounts are exact decimal strings in the book's
 * major unit, the representation inventory computes in. They become whole minor
 * units only inside `postJournalEntry`, and only through `toMinorUnits`. A line
 * is a debit or a credit, never both.
 */
export interface InventoryJournalLine {
  purpose: InventoryJournalPurpose;
  debit?: string;
  credit?: string;
  description?: string;
}

export type InventoryJournalDraft = InventoryJournalSource & {
  orgId: string;
  /** Who caused the post. `null` for an unattended one. */
  createdBy: string | null;
  entryDate: string;
  description: string;
  sourceId: string;
  lines: InventoryJournalLine[];
};

/**
 * A decimal amount as whole minor units: hundredths, rounded half away from zero.
 *
 * Exact. It uses `BigInt` on the digits and never multiplies a float by 100,
 * because at a tie that multiplication is where a figure changes and nothing
 * reports it (`1.005 * 100` is `100.49999…`). Two decimals is the convention
 * every kernel-era inventory post uses: `StockMovementBridgeService`,
 * `grn-receive`'s receipt and `so-fulfillment`'s COGS all multiply by 100.
 * Matching them keeps one receipt from being valued differently by its two
 * paths and keeps the kernel's reconciliation from reporting its own rounding.
 *
 * Negative amounts are refused. A line carries a magnitude, and its direction is
 * whether it is a debit or a credit.
 */
export function toMinorUnits(amount: string): number {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!match) {
    throw new UnprocessableEntityException(
      `${JSON.stringify(amount)} is not an amount the general ledger can take`,
    );
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const hundredths = BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  const rounded = Number(fraction.charAt(2) || "0") >= 5 ? hundredths + 1n : hundredths;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnprocessableEntityException(
      `${amount} is beyond what the general ledger can hold in minor units`,
    );
  }
  return assertSafeMinor(Number(rounded));
}

/** The inverse of `toMinorUnits`, in integer arithmetic: 1234 → "12.34". */
export function minorUnitsToDecimal(minor: number): string {
  const safe = assertSafeMinor(minor);
  const sign = safe < 0 ? "-" : "";
  const abs = Math.abs(safe);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

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
