import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  journalEntries,
  journalLines,
  ledgerAccounts,
  finBankAccounts,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import type { InsightsQuery, AnomalyFinding } from "./dto/insights.schemas";
import { InsightsFindersService, monthStart, monthEnd, todayIso } from "./insights-finders.service";

const ANOMALY_TTL = 300;

@Injectable()
export class InsightsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly finders: InsightsFindersService,
  ) {}

  async getAnomalies(orgId: string, query: InsightsQuery): Promise<AnomalyFinding[]> {
    const cacheKey = `fin:insights:anomalies:${orgId}:${query.from ?? ""}:${query.to ?? ""}`;
    return this.cache.cached(cacheKey, () => this.computeAnomalies(orgId, query), ANOMALY_TTL);
  }

  private async computeAnomalies(orgId: string, query: InsightsQuery): Promise<AnomalyFinding[]> {
    const from = query.from ?? monthStart(1);
    const to = query.to ?? todayIso();

    const results = await Promise.all([
      this.finders.findExpenseSpikes(orgId, from, to).catch(() => [] as AnomalyFinding[]),
      this.finders.findDuplicateBills(orgId, from, to).catch(() => [] as AnomalyFinding[]),
      this.finders.findUnusualJournals(orgId, from, to).catch(() => [] as AnomalyFinding[]),
      this.finders.findRoundAmountPatterns(orgId, from, to).catch(() => [] as AnomalyFinding[]),
      this.finders.findArConcentration(orgId).catch(() => [] as AnomalyFinding[]),
      this.finders.findCashDipProjected(orgId).catch(() => [] as AnomalyFinding[]),
    ]);

    return results.flat();
  }

  async getDigest(orgId: string): Promise<{ headline: string; positives: string[]; watchouts: string[] }> {
    return this.cache.cached(
      `fin:insights:digest:${orgId}`,
      () => this.computeDigest(orgId),
      ANOMALY_TTL,
    );
  }

  private async computeDigest(
    orgId: string,
  ): Promise<{ headline: string; positives: string[]; watchouts: string[] }> {
    const today = todayIso();
    const [anomalies, overviewData] = await Promise.all([
      this.computeAnomalies(orgId, {}),
      this.queryOverviewAggregates(orgId, monthStart(0), today),
    ]);

    const criticals = anomalies.filter((a) => a.severity === "critical");
    const warnings = anomalies.filter((a) => a.severity === "warning");
    const { netProfit, revenueThisMonth, runwayMonths } = overviewData;

    let headline: string;
    if (criticals.length > 0) {
      headline = `${criticals.length} critical financial anomaly${criticals.length > 1 ? "ies" : ""} require immediate attention.`;
    } else if (warnings.length > 0) {
      headline = `${warnings.length} financial warning${warnings.length > 1 ? "s" : ""} detected — review recommended.`;
    } else if (netProfit >= 0) {
      headline = `Finances look healthy — net profit of ${Math.round(netProfit).toLocaleString()} this month.`;
    } else {
      headline = `Month-to-date net loss of ${Math.abs(Math.round(netProfit)).toLocaleString()} — review expense categories.`;
    }

    const positives: string[] = [];
    if (netProfit > 0) positives.push(`Positive net profit of ${Math.round(netProfit).toLocaleString()} this month.`);
    if (revenueThisMonth > 0 && netProfit > 0) {
      const margin = ((netProfit / revenueThisMonth) * 100).toFixed(1);
      positives.push(`Gross margin at ${margin}% on revenue of ${Math.round(revenueThisMonth).toLocaleString()}.`);
    }
    if (runwayMonths !== null && runwayMonths >= 6) {
      positives.push(`Cash runway of ${runwayMonths} months — comfortable buffer.`);
    }
    if (anomalies.length === 0) positives.push("No anomalies detected across expenses, bills, journals, or AR.");

    const watchouts = [...criticals, ...warnings, ...anomalies.filter((a) => a.severity === "info")]
      .slice(0, 5)
      .map((a) => a.detail);

    if (runwayMonths !== null && runwayMonths < 3) {
      watchouts.push(`Cash runway is critically low at ${runwayMonths.toFixed(1)} months.`);
    }

    return { headline, positives, watchouts };
  }

  private async queryOverviewAggregates(
    orgId: string,
    from: string,
    to: string,
  ): Promise<{ netProfit: number; revenueThisMonth: number; expensesThisMonth: number; runwayMonths: number | null }> {
    const [revExpRows, bankRows, burnRows] = await Promise.all([
      this.db
        .select({
          accountType: ledgerAccounts.accountType,
          totalDebit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        })
        .from(ledgerAccounts)
        .innerJoin(journalLines, eq(journalLines.accountId, ledgerAccounts.id))
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(ledgerAccounts.orgId, orgId),
            inArray(ledgerAccounts.accountType, ["INCOME", "EXPENSE"]),
            eq(journalEntries.status, "POSTED"),
            gte(journalEntries.entryDate, from),
            lte(journalEntries.entryDate, to),
          ),
        )
        .groupBy(ledgerAccounts.accountType),

      this.db
        .select({ balance: finBankAccounts.currentBalance })
        .from(finBankAccounts)
        .where(and(eq(finBankAccounts.orgId, orgId), eq(finBankAccounts.isActive, true))),

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
            gte(journalEntries.entryDate, monthStart(3)),
            lte(journalEntries.entryDate, monthEnd(1)),
          ),
        ),
    ]);

    const incomeRow = revExpRows.find((r) => r.accountType === "INCOME");
    const expenseRow = revExpRows.find((r) => r.accountType === "EXPENSE");
    const revenueThisMonth = Number(incomeRow?.totalCredit ?? 0) - Number(incomeRow?.totalDebit ?? 0);
    const expensesThisMonth = Number(expenseRow?.totalDebit ?? 0) - Number(expenseRow?.totalCredit ?? 0);
    const netProfit = revenueThisMonth - expensesThisMonth;

    const cashBalance = bankRows.reduce((acc, r) => acc + Number(r.balance ?? 0), 0);
    const totalExpense3m =
      Number(burnRows[0]?.totalDebit ?? 0) - Number(burnRows[0]?.totalCredit ?? 0);
    const avgBurn = totalExpense3m > 0 ? totalExpense3m / 3 : 0;
    const runwayMonths = avgBurn > 0 ? Math.floor(cashBalance / avgBurn) : null;

    return { netProfit, revenueThisMonth, expensesThisMonth, runwayMonths };
  }
}
