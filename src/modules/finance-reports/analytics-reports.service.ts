import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, lte, sql, sum } from "drizzle-orm";
import {
  finBankAccounts,
  finBudgets,
  finBudgetLines,
  ledgerAccounts,
  journalEntries,
  journalLines,
  expenses,
  orgUnits,
  projects,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";

function monthStart(monthsAgo: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  return d.toISOString().slice(0, 10);
}

function monthEnd(monthsAgo: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 0));
  return d.toISOString().slice(0, 10);
}

function addMonths(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10).slice(0, 7);
}

@Injectable()
export class AnalyticsReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async projectProfitability(orgId: string, from: string, to: string) {
    return this.cache.cached(
      CACHE_KEYS.finProjectProfitability(orgId, from, to),
      () => this.computeProjectProfitability(orgId, from, to),
      CACHE_TTL.MEDIUM,
    );
  }

  private async computeProjectProfitability(orgId: string, from: string, to: string) {
    const [revenueRows, costJournalRows, costExpenseRows] = await Promise.all([
      this.db
        .select({
          projectId: journalLines.projectId,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.status, "POSTED"),
            eq(ledgerAccounts.accountType, "INCOME"),
            isNotNull(journalLines.projectId),
            gte(journalEntries.entryDate, from),
            lte(journalEntries.entryDate, to),
          ),
        )
        .groupBy(journalLines.projectId),

      this.db
        .select({
          projectId: journalLines.projectId,
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.status, "POSTED"),
            eq(ledgerAccounts.accountType, "EXPENSE"),
            isNotNull(journalLines.projectId),
            gte(journalEntries.entryDate, from),
            lte(journalEntries.entryDate, to),
          ),
        )
        .groupBy(journalLines.projectId),

      this.db
        .select({
          projectId: expenses.projectId,
          totalAmount: sql<string>`coalesce(sum(${expenses.amount}), 0)`,
        })
        .from(expenses)
        .where(
          and(
            eq(expenses.orgId, orgId),
            inArray(expenses.status, ["APPROVED", "PAID"]),
            isNotNull(expenses.projectId),
            gte(expenses.expenseDate, from),
            lte(expenses.expenseDate, to),
          ),
        )
        .groupBy(expenses.projectId),
    ]);

    const allProjectIds = new Set<number>();
    for (const r of revenueRows) if (r.projectId !== null) allProjectIds.add(r.projectId);
    for (const r of costJournalRows) if (r.projectId !== null) allProjectIds.add(r.projectId);
    for (const r of costExpenseRows) if (r.projectId !== null) allProjectIds.add(r.projectId);

    if (allProjectIds.size === 0) return [];

    const projectRows = await this.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, Array.from(allProjectIds)));
    const projectMap = new Map(projectRows.map((p) => [p.id, p.name]));

    const revenueMap = new Map(revenueRows.map((r) => [r.projectId, r]));
    const costJMap = new Map(costJournalRows.map((r) => [r.projectId, r]));
    const costEMap = new Map(costExpenseRows.map((r) => [r.projectId, r]));

    return Array.from(allProjectIds).map((pid) => {
      const rev = revenueMap.get(pid);
      const cj = costJMap.get(pid);
      const ce = costEMap.get(pid);
      const revenue = Number(rev?.totalCredit ?? 0) - Number(rev?.totalDebit ?? 0);
      const costJournal = Number(cj?.totalDebit ?? 0) - Number(cj?.totalCredit ?? 0);
      const costExpense = Number(ce?.totalAmount ?? 0);
      const cost = costJournal + costExpense;
      const margin = revenue - cost;
      const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0;
      return {
        projectId: pid,
        projectName: projectMap.get(pid) ?? `Project ${pid}`,
        revenue: revenue.toFixed(2),
        cost: cost.toFixed(2),
        margin: margin.toFixed(2),
        marginPct: marginPct.toFixed(2),
      };
    });
  }

  async departmentProfitability(orgId: string, from: string, to: string) {
    return this.cache.cached(
      CACHE_KEYS.finDeptProfitability(orgId, from, to),
      () => this.computeDeptProfitability(orgId, from, to),
      CACHE_TTL.MEDIUM,
    );
  }

  private async computeDeptProfitability(orgId: string, from: string, to: string) {
    const [revenueRows, costRows] = await Promise.all([
      this.db
        .select({
          departmentId: journalLines.departmentId,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.status, "POSTED"),
            eq(ledgerAccounts.accountType, "INCOME"),
            isNotNull(journalLines.departmentId),
            gte(journalEntries.entryDate, from),
            lte(journalEntries.entryDate, to),
          ),
        )
        .groupBy(journalLines.departmentId),

      this.db
        .select({
          departmentId: journalLines.departmentId,
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.status, "POSTED"),
            eq(ledgerAccounts.accountType, "EXPENSE"),
            isNotNull(journalLines.departmentId),
            gte(journalEntries.entryDate, from),
            lte(journalEntries.entryDate, to),
          ),
        )
        .groupBy(journalLines.departmentId),
    ]);

    const allDeptIds = new Set<string>();
    for (const r of revenueRows) if (r.departmentId !== null) allDeptIds.add(r.departmentId);
    for (const r of costRows) if (r.departmentId !== null) allDeptIds.add(r.departmentId);

    if (allDeptIds.size === 0) return [];

    const deptRows = await this.db
      .select({ id: orgUnits.id, name: orgUnits.name })
      .from(orgUnits)
      .where(inArray(orgUnits.id, Array.from(allDeptIds)));
    const deptMap = new Map(deptRows.map((d) => [d.id, d.name]));

    const revMap = new Map(revenueRows.map((r) => [r.departmentId, r]));
    const costMap = new Map(costRows.map((r) => [r.departmentId, r]));

    return Array.from(allDeptIds).map((did) => {
      const rev = revMap.get(did);
      const cst = costMap.get(did);
      const revenue = Number(rev?.totalCredit ?? 0) - Number(rev?.totalDebit ?? 0);
      const cost = Number(cst?.totalDebit ?? 0) - Number(cst?.totalCredit ?? 0);
      const margin = revenue - cost;
      const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0;
      return {
        departmentId: did,
        departmentName: deptMap.get(did) ?? `Department ${did}`,
        revenue: revenue.toFixed(2),
        cost: cost.toFixed(2),
        margin: margin.toFixed(2),
        marginPct: marginPct.toFixed(2),
      };
    });
  }

  async budgetVsActual(orgId: string, budgetId: number, from: string, to: string) {
    return this.cache.cached(
      CACHE_KEYS.finBudgetVsActual(orgId, budgetId, from, to),
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
    return this.cache.cached(
      CACHE_KEYS.finWorkingCapital(orgId, asOf),
      () => this.computeWorkingCapital(orgId, asOf),
      CACHE_TTL.MEDIUM,
    );
  }

  private async computeWorkingCapital(orgId: string, asOf: string) {
    const [assetRows, liabilityRows] = await Promise.all([
      this.db
        .select({
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.status, "POSTED"),
            eq(ledgerAccounts.accountType, "ASSET"),
            lte(journalEntries.entryDate, asOf),
            sql`${ledgerAccounts.code} < '1500'`,
          ),
        ),

      this.db
        .select({
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.status, "POSTED"),
            eq(ledgerAccounts.accountType, "LIABILITY"),
            lte(journalEntries.entryDate, asOf),
            sql`${ledgerAccounts.code} < '2500'`,
          ),
        ),
    ]);

    const currentAssets =
      Number(assetRows[0]?.totalDebit ?? 0) - Number(assetRows[0]?.totalCredit ?? 0);
    const currentLiabilities =
      Number(liabilityRows[0]?.totalCredit ?? 0) - Number(liabilityRows[0]?.totalDebit ?? 0);
    const workingCapitalAmt = currentAssets - currentLiabilities;
    const ratio = currentLiabilities > 0 ? currentAssets / currentLiabilities : null;

    return {
      asOf,
      currentAssets: currentAssets.toFixed(2),
      currentLiabilities: currentLiabilities.toFixed(2),
      workingCapital: workingCapitalAmt.toFixed(2),
      ratio: ratio !== null ? ratio.toFixed(4) : null,
    };
  }

  async burnRate(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.finBurnRate(orgId),
      () => this.computeBurnRate(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async computeBurnRate(orgId: string) {
    const months: Array<{ label: string; from: string; to: string }> = [
      { label: monthStart(3).slice(0, 7), from: monthStart(3), to: monthEnd(3) },
      { label: monthStart(2).slice(0, 7), from: monthStart(2), to: monthEnd(2) },
      { label: monthStart(1).slice(0, 7), from: monthStart(1), to: monthEnd(1) },
    ];

    const monthData = await Promise.all(
      months.map(({ label, from, to }) =>
        this.db
          .select({
            totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
            totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
          })
          .from(journalLines)
          .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.accountId))
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
          .where(
            and(
              eq(journalEntries.orgId, orgId),
              eq(journalEntries.status, "POSTED"),
              eq(ledgerAccounts.accountType, "EXPENSE"),
              gte(journalEntries.entryDate, from),
              lte(journalEntries.entryDate, to),
            ),
          )
          .then((rows) => ({
            label,
            netOutflow: Number(rows[0]?.totalDebit ?? 0) - Number(rows[0]?.totalCredit ?? 0),
          })),
      ),
    );

    const totalOutflow = monthData.reduce((acc, m) => acc + m.netOutflow, 0);
    const averageBurnRate = totalOutflow / 3;

    return {
      months: monthData.map((m) => ({
        month: m.label,
        netOutflow: m.netOutflow.toFixed(2),
      })),
      averageBurnRate: averageBurnRate.toFixed(2),
    };
  }

  async cashRunway(orgId: string, months: number) {
    return this.cache.cached(
      CACHE_KEYS.finCashRunway(orgId, months),
      () => this.computeCashRunway(orgId, months),
      CACHE_TTL.MEDIUM,
    );
  }

  private async computeCashRunway(orgId: string, months: number) {
    const bankRows = await this.db
      .select({ balance: finBankAccounts.currentBalance })
      .from(finBankAccounts)
      .where(and(eq(finBankAccounts.orgId, orgId), eq(finBankAccounts.isActive, true)));

    const cashBalance = bankRows.reduce((acc, r) => acc + Number(r.balance ?? 0), 0);

    const burnData = await this.computeBurnRate(orgId);
    const averageBurnRate = Number(burnData.averageBurnRate);
    const runwayMonths = averageBurnRate > 0 ? Math.floor(cashBalance / averageBurnRate) : null;

    const today = new Date().toISOString().slice(0, 7);
    const projectedMonths: Array<{ month: string; projectedBalance: string }> = [];
    for (let i = 1; i <= months; i++) {
      const month = addMonths(today + "-01", i);
      const projectedBalance = cashBalance - averageBurnRate * i;
      projectedMonths.push({ month, projectedBalance: projectedBalance.toFixed(2) });
    }

    return {
      cashBalance: cashBalance.toFixed(2),
      averageBurnRate: averageBurnRate.toFixed(2),
      runwayMonths,
      projectedMonths,
    };
  }
}
