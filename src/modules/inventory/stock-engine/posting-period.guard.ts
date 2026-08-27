import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { PeriodsService } from "../../accounting/gl/periods.service";

/**
 * The accounting period check, as a dependency inventory can survive without.
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
export class PostingPeriodGuard {
  private readonly logger = new Logger(PostingPeriodGuard.name);
  /**
   * Resolved once per process. A table appearing later is a migration, and a
   * migration restarts the application — so inventory begins enforcing periods
   * on the next boot after accounting is installed, not mid-process.
   */
  private periodsInstalled: Promise<boolean> | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly periods: PeriodsService,
  ) {}

  private hasPeriodTable(): Promise<boolean> {
    this.periodsInstalled ??= this.db
      .execute<{ present: string | null }>(sql`SELECT to_regclass('public.accounting_periods')::text AS present`)
      .then((rows) => {
        const present = rows[0]?.present != null;
        if (!present)
          this.logger.warn(
            "accounting_periods is absent; stock posting-date control is inactive until the accounting module is migrated",
          );
        return present;
      });
    return this.periodsInstalled;
  }

  /** Refuses a movement into a closed or locked period, where periods exist. */
  async assertOpen(orgId: string, postingDate: string): Promise<void> {
    if (!(await this.hasPeriodTable())) return;
    await this.periods.assertPeriodOpen(orgId, new Date(postingDate));
  }
}
