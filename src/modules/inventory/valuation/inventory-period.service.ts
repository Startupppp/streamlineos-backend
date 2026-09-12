import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { glPeriods } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";

export interface InventoryPeriod {
  /** `gl_periods.id`, a uuid. Numeric before the accounting rewrite. */
  periodId: string;
  name: string;
  startDate: string;
  endDate: string;
  /** `OPEN` or `LOCKED`. The kernel has no CLOSED state. */
  status: string;
}

/** A valuation grain: one date, and the period it came from when it came from one. */
export interface AsAtGrain {
  asOfDate: string;
  period: InventoryPeriod | null;
}

/** A reconciliation grain: a closed date range, and its period when it has one. */
export interface PeriodWindow {
  fromDate: string;
  toDate: string;
  period: InventoryPeriod | null;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Every column a period is read with, in one place, so the three reads cannot drift. */
const PERIOD_COLUMNS = {
  periodId: glPeriods.id,
  name: glPeriods.name,
  startDate: glPeriods.startsOn,
  endDate: glPeriods.endsOn,
  status: glPeriods.status,
};

/**
 * D5/D6 — the accounting period, borrowed by inventory without depending on it.
 *
 * Since the accounting rewrite a period is a `gl_periods` row of the
 * organisation's DEFAULT BOOK. The legacy `accounting_periods` table is gone.
 * Inventory is still separately licensed from accounting: an organisation that
 * has not enabled accounting has no book, and it still gets a valuation, quoted
 * at a plain date instead of a period name. `installed` in the list response
 * now means "this organisation keeps books", which is the only thing it can
 * mean when the tables always exist.
 *
 * Every read carries both the tenant and the book, so a period id from another
 * organisation or another book is a 404 rather than a 403: a 403 would confirm
 * the id exists (§4).
 */
@Injectable()
export class InventoryPeriodService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly bridge: InventoryAccountingBridge,
  ) {}

  async listPeriods(orgId: string): Promise<{ installed: boolean; items: InventoryPeriod[] }> {
    const bookId = await this.bridge.defaultBookId(orgId);
    if (bookId === null) return { installed: false, items: [] };
    const rows = await this.db
      .select({ ...PERIOD_COLUMNS })
      .from(glPeriods)
      .where(and(eq(glPeriods.orgId, orgId), eq(glPeriods.bookId, bookId)))
      .orderBy(asc(glPeriods.startsOn))
      .limit(100);
    return { installed: true, items: rows };
  }

  /** A period the caller named, or `null` when they named none. */
  async findPeriod(orgId: string, periodId: string | undefined): Promise<InventoryPeriod | null> {
    if (periodId == null) return null;
    const bookId = await this.bridge.defaultBookId(orgId);
    if (bookId === null)
      throw new NotFoundException("Accounting periods are not available in this workspace");
    const [row] = await this.db
      .select({ ...PERIOD_COLUMNS })
      .from(glPeriods)
      .where(
        and(
          eq(glPeriods.orgId, orgId),
          eq(glPeriods.bookId, bookId),
          eq(glPeriods.id, periodId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Accounting period not found");
    return row;
  }

  /** The date a valuation is quoted at: the period's last day, or the given day. */
  async resolveAsAt(
    orgId: string,
    input: { asOfDate?: string; periodId?: string },
  ): Promise<AsAtGrain> {
    const period = await this.findPeriod(orgId, input.periodId);
    if (period) return { asOfDate: input.asOfDate ?? period.endDate, period };
    return { asOfDate: input.asOfDate ?? todayIso(), period: null };
  }

  /**
   * The range a reconciliation runs over. A period supplies both ends; without
   * one the caller's dates are used, defaulting to the current calendar month so
   * the report is never an unbounded scan of the ledger.
   */
  async resolveWindow(
    orgId: string,
    input: { periodId?: string; fromDate?: string; toDate?: string },
  ): Promise<PeriodWindow> {
    const period = await this.findPeriod(orgId, input.periodId);
    if (period)
      return {
        fromDate: input.fromDate ?? period.startDate,
        toDate: input.toDate ?? period.endDate,
        period,
      };
    const today = todayIso();
    return {
      fromDate: input.fromDate ?? `${today.slice(0, 7)}-01`,
      toDate: input.toDate ?? today,
      period: null,
    };
  }

  /** The period covering a date, for labelling a row the caller did not scope. */
  async periodCovering(orgId: string, date: string): Promise<InventoryPeriod | null> {
    const bookId = await this.bridge.defaultBookId(orgId);
    if (bookId === null) return null;
    const [row] = await this.db
      .select({ ...PERIOD_COLUMNS })
      .from(glPeriods)
      .where(
        and(
          eq(glPeriods.orgId, orgId),
          eq(glPeriods.bookId, bookId),
          lte(glPeriods.startsOn, date),
          gte(glPeriods.endsOn, date),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
