import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { ledgerAccounts } from "../../../db/schema";
import { PeriodsService } from "../../accounting/gl/periods.service";
import { JournalPostingService } from "../../accounting/posting/journal-posting.service";

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
   */
  async postJournalEntry(
    draft: Parameters<JournalPostingService["persistJournalEntry"]>[0],
  ): Promise<void> {
    if (!(await this.hasJournals())) return;

    const codes = [...new Set(draft.lines.map((line) => line.accountCode))];
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

    await this.journals.persistJournalEntry(draft);
  }
}
