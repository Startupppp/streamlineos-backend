import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { accountingPeriods } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";

export interface InventoryPeriod {
  periodId: number;
  name: string;
  startDate: string;
  endDate: string;
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

/**
 * D5/D6 — the accounting period, borrowed by inventory without depending on it.
 *
 * Inventory is separately licensed from accounting and `accounting_periods` is
 * one of the declared tables that does not exist in every database — the same
 * fact `InventoryAccountingBridge` exists for. So every read here is gated on
 * that class's memoised `to_regclass` probe rather than on catching `42P01`,
 * which would poison the surrounding transaction, and a tenant with no
 * accounting module still gets a valuation: it just quotes a plain date instead
 * of a period name.
 */
@Injectable()
export class InventoryPeriodService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly bridge: InventoryAccountingBridge,
  ) {}

  async listPeriods(orgId: string): Promise<{ installed: boolean; items: InventoryPeriod[] }> {
    if (!(await this.bridge.hasPeriods())) return { installed: false, items: [] };
    const rows = await this.db
      .select({
        periodId: accountingPeriods.id,
        name: accountingPeriods.name,
        startDate: accountingPeriods.startDate,
        endDate: accountingPeriods.endDate,
        status: accountingPeriods.status,
      })
      .from(accountingPeriods)
      .where(eq(accountingPeriods.orgId, orgId))
      .orderBy(asc(accountingPeriods.startDate))
      .limit(100);
    return { installed: true, items: rows };
  }

  /**
   * A period the caller named, or `null` when they named none.
   *
   * A period id that belongs to another tenant, or to a database with no
   * accounting module, is a 404 rather than a 403 — a 403 on an id the caller
   * may not see confirms it exists (§4).
   */
  async findPeriod(orgId: string, periodId: number | undefined): Promise<InventoryPeriod | null> {
    if (periodId == null) return null;
    if (!(await this.bridge.hasPeriods()))
      throw new NotFoundException("Accounting periods are not available in this workspace");
    const [row] = await this.db
      .select({
        periodId: accountingPeriods.id,
        name: accountingPeriods.name,
        startDate: accountingPeriods.startDate,
        endDate: accountingPeriods.endDate,
        status: accountingPeriods.status,
      })
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.orgId, orgId), eq(accountingPeriods.id, periodId)))
      .limit(1);
    if (!row) throw new NotFoundException("Accounting period not found");
    return row;
  }

  /** The date a valuation is quoted at: the period's last day, or the given day. */
  async resolveAsAt(
    orgId: string,
    input: { asOfDate?: string; periodId?: number },
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
    input: { periodId?: number; fromDate?: string; toDate?: string },
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
    if (!(await this.bridge.hasPeriods())) return null;
    const [row] = await this.db
      .select({
        periodId: accountingPeriods.id,
        name: accountingPeriods.name,
        startDate: accountingPeriods.startDate,
        endDate: accountingPeriods.endDate,
        status: accountingPeriods.status,
      })
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.orgId, orgId),
          sql`${accountingPeriods.startDate} <= ${date}::date`,
          sql`${accountingPeriods.endDate} >= ${date}::date`,
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
