import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
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

  /** Refuses a movement into a closed or locked period, where periods exist. */
  async assertOpen(orgId: string, postingDate: string): Promise<void> {
    const has = await this.installed(
      "accounting_periods",
      "stock posting-date control is inactive until the accounting module is migrated",
    );
    if (!has) return;
    await this.periods.assertPeriodOpen(orgId, new Date(postingDate));
  }

  /**
   * Posts the accounting entry for a stock event, where the ledger exists.
   *
   * Receiving goods, shipping and invoicing each write a journal entry, and each
   * died on `42P01 relation "journal_entries" does not exist` — the same defect
   * that killed the stock engine, in three more places. A warehouse must be able
   * to receive goods whether or not the tenant has bought accounting.
   */
  async postJournalEntry(
    draft: Parameters<JournalPostingService["persistJournalEntry"]>[0],
  ): Promise<void> {
    const has = await this.installed(
      "journal_entries",
      "inventory movements will not produce accounting entries until the accounting module is migrated",
    );
    if (!has) return;
    await this.journals.persistJournalEntry(draft);
  }
}
