import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  finBudgets,
  finBudgetLines,
  ledgerAccounts,
  journalEntries,
  journalLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import {
  computeDeptProfitability,
  computeProjectProfitability,
  type AnalyticsReportDeps,
} from "./lib/profitability-reports";
import {
  computeBurnRate,
  computeCashRunway,
  computeWorkingCapital,
} from "./lib/liquidity-reports";

@Injectable()
export class AnalyticsReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private get reportDeps(): AnalyticsReportDeps {
    return { db: this.db };
  }

  async projectProfitability(orgId: string, from: string, to: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `proj-profit:${from}:${to}`,
      () => computeProjectProfitability(this.reportDeps, orgId, from, to),
      CACHE_TTL.MEDIUM,
    );
  }

  async departmentProfitability(orgId: string, from: string, to: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `dept-profit:${from}:${to}`,
      () => computeDeptProfitability(this.reportDeps, orgId, from, to),
      CACHE_TTL.MEDIUM,
    );
  }

  async budgetVsActual(orgId: string, budgetId: number, from: string, to: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finBvaNamespace(orgId, budgetId),
      `${from}:${to}`,
      () => this.computeBudgetVsActual(orgId, budgetId, from, to),
      CACHE_TTL.MEDIUM,
    );
  }

  private async computeBudgetVsActual(orgId: string, budgetId: number, from: string, to: string) {
    const budgetRows = await this.db
      .select({ id: finBudgets.id, name: finBudgets.name, fiscalYear: finBudgets.fiscalYear })
      .from(finBudgets)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)))
      .limit(1);
    if (!budgetRows[0]) throw new NotFoundException("Budget not found");
    const budget = budgetRows[0];

    const budgetLineRows = await this.db
      .select({
        accountId: finBudgetLines.accountId,
        accountName: ledgerAccounts.name,
        periodKey: finBudgetLines.periodKey,
        amount: finBudgetLines.amount,
      })
      .from(finBudgetLines)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, finBudgetLines.accountId))
      .where(and(eq(finBudgetLines.budgetId, budgetId), eq(finBudgetLines.orgId, orgId)));

    if (budgetLineRows.length === 0) {
      return { budget, lines: [] };
    }

    const accountIds = [...new Set(budgetLineRows.map((l) => l.accountId))];

    const actualRows = await this.db
      .select({
        accountId: journalLines.accountId,
        periodKey: sql<string>`to_char(date_trunc('month', ${journalEntries.entryDate}::date), 'YYYY-MM')`,
        totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        accountType: ledgerAccounts.accountType,
      })
      .from(journalLines)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(journalEntries.orgId, orgId),
          eq(journalEntries.status, "POSTED"),
          inArray(journalLines.accountId, accountIds),
          gte(journalEntries.entryDate, from),
          lte(journalEntries.entryDate, to),
        ),
      )
      .groupBy(
        journalLines.accountId,
        ledgerAccounts.accountType,
        sql`date_trunc('month', ${journalEntries.entryDate}::date)`,
      );

    const actualMap = new Map<string, number>();
    for (const r of actualRows) {
      const key = `${r.accountId}::${r.periodKey}`;
      const debit = Number(r.totalDebit ?? 0);
      const credit = Number(r.totalCredit ?? 0);
      const normalDebit = r.accountType === "ASSET" || r.accountType === "EXPENSE";
      actualMap.set(key, normalDebit ? debit - credit : credit - debit);
    }

    const lines = budgetLineRows.map((bl) => {
      const key = `${bl.accountId}::${bl.periodKey}`;
      const budgetAmount = Number(bl.amount ?? 0);
      const actualAmount = actualMap.get(key) ?? 0;
      const variance = actualAmount - budgetAmount;
      const variancePct = budgetAmount !== 0 ? (variance / Math.abs(budgetAmount)) * 100 : 0;
      return {
        accountId: bl.accountId,
        accountName: bl.accountName,
        periodKey: bl.periodKey,
        budgetAmount: budgetAmount.toFixed(2),
        actualAmount: actualAmount.toFixed(2),
        variance: variance.toFixed(2),
        variancePct: variancePct.toFixed(2),
      };
    });

    return { budget, lines };
  }

  async workingCapital(orgId: string, asOf: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `working-capital:${asOf}`,
      () => computeWorkingCapital(this.reportDeps, orgId, asOf),
      CACHE_TTL.MEDIUM,
    );
  }

  async burnRate(orgId: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      "burn-rate",
      () => computeBurnRate(this.reportDeps, orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  async cashRunway(orgId: string, months: number) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.finReportsNamespace(orgId),
      `cash-runway:${months}`,
      () => computeCashRunway(this.reportDeps, orgId, months),
      CACHE_TTL.MEDIUM,
    );
  }
}
