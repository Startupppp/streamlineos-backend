import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { ledgerAccounts } from "../../../db/schema";
import { PeriodsService } from "../../accounting/gl/periods.service";
import { JournalPostingService } from "../../accounting/posting/journal-posting.service";
import {
  FinancePostingAccountsService,
  PURPOSE_DEFAULT_CODE,
} from "../../accounting/posting/finance-posting-accounts.service";
import type { SystemAccountPurpose } from "../../accounting/core/finance-posting.types";

/**
 * INV-09 — every system-account purpose inventory posts against, and nothing
 * else.
 *
 * Written as a list rather than as the whole `SystemAccountPurpose` union so
 * one resolution round-trip answers for every call site, and so a reader can
 * see inventory's entire footprint in the chart of accounts in six lines.
 *
 * Two of the six inventory purposes are deliberately absent:
 *
 *   INVENTORY_WRITE_OFF, INVENTORY_ADJUSTMENT_GAIN_LOSS
 *     Nothing in inventory posts a journal for an adjustment, a write-off or a
 *     cycle count — `gl-recon`'s "unposted by design" list is exactly that set.
 *     Naming them here would claim a posting that does not exist.
 *
 *   INVENTORY_LANDED_COST_CLEARING
 *     A landed-cost voucher credits the payable, not a clearing account, and
 *     `PAYABLE_ACCOUNT` in `landed-cost-apply.service.ts` argues at length why:
 *     the voucher is one event, nothing in AP would ever drain a clearing
 *     account, and crediting one would book a balance that grows forever. That
 *     is INV-38's decision to take, not this change's. Resolving the credit
 *     through `AP` keeps the semantics the code already documents while still
 *     honouring an admin's AP mapping.
 *
 * `AR` and `SALES_INCOME` are here because the sales-order invoice entry names
 * 1200 and 4000, which are those two purposes' defaults; they are not
 * inventory's purposes, but they are accounts inventory posts to.
 */
export const INVENTORY_JOURNAL_PURPOSES = [
  "INVENTORY_ASSET",
  "INVENTORY_COGS",
  "INVENTORY_GRNI",
  "AP",
  "AR",
  "SALES_INCOME",
] as const satisfies readonly SystemAccountPurpose[];

export type InventoryJournalPurpose = (typeof INVENTORY_JOURNAL_PURPOSES)[number];

export type InventoryAccountCodes = Record<InventoryJournalPurpose, string>;

type JournalDraft = Parameters<JournalPostingService["persistJournalEntry"]>[0];
type JournalDraftLine = JournalDraft["lines"][number];

/**
 * A journal inventory wants written, named in purposes rather than in codes.
 *
 * The purpose is resolved to a code inside `postJournalEntry`, deliberately and
 * not at the call site: resolution reads `acc_system_account_map`, that table is
 * one of the accounting tables that does not exist in every database, and a
 * caller resolving before the install probe would issue the very query the
 * `to_regclass` design exists to avoid.
 */
export interface InventoryJournalLine extends Omit<JournalDraftLine, "accountCode"> {
  purpose: InventoryJournalPurpose;
}

export interface InventoryJournalDraft extends Omit<JournalDraft, "lines"> {
  lines: InventoryJournalLine[];
}

/**
 * Everything inventory asks of accounting, as dependencies it can survive
 * without.
 *
 * Every stock command calls `PeriodsService.assertPeriodOpen`, which selects
 * from `accounting_periods`. That table is declared in Drizzle and does not
 * exist in this database — it is one of 63 declared tables that do not — so
 * every command through the engine died on `42P01 relation "accounting_periods"
 * does not exist`. That is why `inv_stock_transactions` holds zero rows across
 * 43 organisations: the module's entire write path was unreachable.
 *
 * Inventory is separately licensed from accounting. A tenant that has not
 * installed accounting must still be able to receive goods, and the period guard
 * already passes when no period row covers the date — a missing table is the
 * degenerate case of that, not a different answer.
 *
 * Probed with `to_regclass` rather than by catching the error: Postgres aborts
 * the whole transaction on a statement error and Drizzle takes no per-statement
 * savepoint, so catching 42P01 inside the engine's transaction would poison
 * every statement after it. `to_regclass` returns NULL instead of raising.
 */
@Injectable()
export class InventoryAccountingBridge {
  private readonly logger = new Logger(InventoryAccountingBridge.name);
  /**
   * Resolved once per process, per table. A table appearing later is a
   * migration, and a migration restarts the application — so inventory begins
   * enforcing periods and posting journals on the next boot after accounting is
   * installed, not mid-process.
   */
  private readonly present = new Map<string, Promise<boolean>>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly periods: PeriodsService,
    private readonly journals: JournalPostingService,
    private readonly accounts: FinancePostingAccountsService,
  ) {}

  private installed(table: string, consequence: string): Promise<boolean> {
    const cached = this.present.get(table);
    if (cached) return cached;
    const probe = this.db
      .execute<{ present: string | null }>(sql`SELECT to_regclass(${`public.${table}`})::text AS present`)
      .then((rows) => {
        const found = rows[0]?.present != null;
        if (!found) this.logger.warn(`${table} is absent; ${consequence}`);
        return found;
      });
    this.present.set(table, probe);
    return probe;
  }

  /**
   * D6 — the same two questions this class already answers for itself, asked by
   * the reconciliation report.
   *
   * The report has to say *why* a movement produced no journal, and "accounting
   * is not installed in this database" is a different answer from "this tenant
   * never mapped account 1300". Re-probing with a second `to_regclass` would
   * give a second, independently-drifting opinion of the same fact, so the
   * memoised probe is exposed instead of copied. Read-only: neither accessor
   * posts anything.
   */
  hasJournals(): Promise<boolean> {
    return this.installed(
      "journal_entries",
      "inventory movements will not produce accounting entries until the accounting module is migrated",
    );
  }

  hasPeriods(): Promise<boolean> {
    return this.installed(
      "accounting_periods",
      "stock posting-date control is inactive until the accounting module is migrated",
    );
  }

  /**
   * INV-09 — the account code each purpose posts to for this organisation.
   *
   * Its own probe rather than leaning on `hasJournals()`. The two tables are
   * created by the same migration today, so the second probe is expected to
   * agree with the first every time; it exists because "expected to agree" is
   * not a property Postgres enforces, and a wrong guess here is not a wrong
   * answer but a `42P01` that poisons the caller's whole transaction — which is
   * the exact failure the memoised `to_regclass` design was built to stop. One
   * extra probe, once per process, buys that away.
   *
   * With the map absent every purpose falls back to `PURPOSE_DEFAULT_CODE`,
   * which is the literal the call site used to carry, so a database without
   * accounting posts exactly what it posted before.
   *
   * Read on every post rather than cached. The mapping changes when an admin
   * saves the settings screen and never otherwise, so a cache would be almost
   * always right — and the cost of being briefly wrong is a journal entry
   * against the wrong account, which is an append-only row in someone's ledger.
   * One indexed lookup on `(org_id)` per posted document is not the expensive
   * part of receiving goods.
   */
  async resolveAccountCodes(orgId: string): Promise<InventoryAccountCodes> {
    if (!(await this.hasSystemAccountMap())) return defaultInventoryAccountCodes();
    return this.accounts.resolveAccountCodes(orgId, INVENTORY_JOURNAL_PURPOSES);
  }

  private hasSystemAccountMap(): Promise<boolean> {
    return this.installed(
      "acc_system_account_map",
      "inventory will post to its default account codes; no per-organisation mapping can be read",
    );
  }

  /** Refuses a movement into a closed or locked period, where periods exist. */
  async assertOpen(orgId: string, postingDate: string): Promise<void> {
    if (!(await this.hasPeriods())) return;
    await this.periods.assertPeriodOpen(orgId, new Date(postingDate));
  }

  /**
   * Posts the accounting entry for a stock event, where there is a ledger to
   * post it to.
   *
   * Receiving goods, shipping and invoicing each write a journal entry, and each
   * died on `42P01 relation "journal_entries" does not exist` — the same defect
   * that killed the stock engine, in three more places.
   *
   * Two conditions, not one. The module being installed is not the same
   * question as this tenant having configured it: with the tables present but no
   * chart of accounts, `persistJournalEntry` throws "Seed COA first" and the
   * goods receipt fails with it. A receipt is a physical fact that already
   * happened — refusing to record it because nobody has set up account 1300 puts
   * the warehouse's records further from the truth, not closer.
   *
   * So it is skipped and said out loud rather than swallowed. The gap between
   * stock and the general ledger is exactly what INV-408's reconciliation is for;
   * a silent skip is what would make that reconciliation lie.
   *
   * INV-09 — the draft names purposes and this method turns them into codes,
   * through `acc_system_account_map`. Resolution happens here, after the install
   * probe and before anything is written, because it is a query against a table
   * that may not exist; a call site that resolved for itself would have to repeat
   * the probe or risk the `42P01` this class exists to prevent.
   */
  async postJournalEntry(draft: InventoryJournalDraft): Promise<void> {
    if (!(await this.hasJournals())) return;

    const accountCodes = await this.resolveAccountCodes(draft.orgId);
    const lines: JournalDraftLine[] = draft.lines.map(({ purpose, ...line }) => ({
      ...line,
      accountCode: accountCodes[purpose],
    }));

    const codes = [...new Set(lines.map((line) => line.accountCode))];
    const found = await this.db
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.orgId, draft.orgId), inArray(ledgerAccounts.code, codes)));
    const missing = codes.filter((code) => !found.some((row) => row.code === code));
    if (missing.length > 0) {
      // Checked rather than caught: `persistJournalEntry` raises a plain Error
      // here, but the accounts lookup is a real query, and letting it fail inside
      // the caller's transaction is a habit that breaks the moment the thrown
      // thing is a Postgres error instead.
      this.logger.warn(
        `no chart-of-accounts entry for ${missing.join(", ")} in org ${draft.orgId}; ` +
          `"${draft.description}" moved stock but produced no accounting entry`,
      );
      return;
    }

    await this.journals.persistJournalEntry({ ...draft, lines });
  }
}

/**
 * What inventory posts to where no per-organisation mapping can be read.
 *
 * Built from `PURPOSE_DEFAULT_CODE` rather than retyped, so the fallback and the
 * fallback the accounting resolver uses cannot drift apart — a second copy of
 * these six numbers is exactly how "the settings screen offers one account and
 * posting uses another" happens.
 */
function defaultInventoryAccountCodes(): InventoryAccountCodes {
  return Object.fromEntries(
    INVENTORY_JOURNAL_PURPOSES.map((purpose) => [purpose, PURPOSE_DEFAULT_CODE[purpose]]),
  ) as InventoryAccountCodes;
}
