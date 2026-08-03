import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, lte, gte, sql, count } from "drizzle-orm";
import {
  finBankAccounts,
  finBankTransactions,
  finApprovalRequests,
  ledgerAccounts,
  journalEntries,
  journalLines,
  invoices,
  purchaseBills,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { OverviewQuery } from "./dto/finance-reports.schemas";

function todayIso(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const from = `${yyyy}-${mm}-01`;
  const lastDay = new Date(Date.UTC(yyyy, now.getUTCMonth() + 1, 0)).getUTCDate();
  const to = `${yyyy}-${mm}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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

@Injectable()
export class OverviewService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getOverview(orgId: string, query: OverviewQuery) {
    const range = query.from && query.to ? { from: query.from, to: query.to } : currentMonthRange();
    const { from, to } = range;
    const cacheKey =
      query.from && query.to
        ? CACHE_KEYS.finOverviewWithDates(orgId, from, to)
        : CACHE_KEYS.finOverview(orgId);

    return this.cache.cached(
      cacheKey,
      () => this.computeOverview(orgId, from, to),
      60,
    );
  }

  private async computeOverview(orgId: string, from: string, to: string) {
    const today = todayIso();
    const next7 = addDays(today, 7);

    const [
      bankAccounts,
      revExpRows,
      arOverdueRows,
      apDueRows,
      reconGapRows,
      openApprovalRows,
      trendRows,
      burnRows,
      outputTaxRows,
      inputTaxRows,
    ] = await Promise.all([
      this.db
        .select({
          id: finBankAccounts.id,
          name: finBankAccounts.name,
          balance: finBankAccounts.currentBalance,
        })
        .from(finBankAccounts)
        .where(and(eq(finBankAccounts.orgId, orgId), eq(finBankAccounts.isActive, true))),

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
        .select({
          cnt: sql<string>`count(*)`,
          total: sql<string>`coalesce(sum(${invoices.total} - ${invoices.amountPaid}), 0)`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.orgId, orgId),
            sql`(${invoices.status} = 'OVERDUE' OR (${invoices.status} = 'ISSUED' AND ${invoices.dueDate} < ${today}))`,
          ),
        ),

      this.db
        .select({
          cnt: sql<string>`count(*)`,
          total: sql<string>`coalesce(sum(${purchaseBills.total} - ${purchaseBills.amountPaid}), 0)`,
        })
        .from(purchaseBills)
        .where(
          and(
            eq(purchaseBills.orgId, orgId),
            inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID"]),
            lte(purchaseBills.dueDate, next7),
          ),
        ),

      this.db
        .select({ cnt: count() })
        .from(finBankTransactions)
        .where(
          and(
            eq(finBankTransactions.orgId, orgId),
            inArray(finBankTransactions.status, ["UNMATCHED", "SUGGESTED"]),
          ),
        ),

      this.db
        .select({ cnt: count() })
        .from(finApprovalRequests)
        .where(
          and(
            eq(finApprovalRequests.orgId, orgId),
            eq(finApprovalRequests.status, "PENDING"),
          ),
        ),

      this.db
        .select({
          month: sql<string>`to_char(date_trunc('month', ${journalEntries.entryDate}::date), 'YYYY-MM')`,
          accountType: ledgerAccounts.accountType,
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
            inArray(ledgerAccounts.accountType, ["INCOME", "EXPENSE"]),
            gte(journalEntries.entryDate, monthStart(11)),
          ),
        )
        .groupBy(
          sql`date_trunc('month', ${journalEntries.entryDate}::date)`,
          ledgerAccounts.accountType,
        )
        .orderBy(sql`date_trunc('month', ${journalEntries.entryDate}::date)`),

      Promise.all([
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
      ]),

      this.db
        .select({
          outputCgst: sql<string>`coalesce(sum(${invoices.cgstAmount}), 0)`,
          outputSgst: sql<string>`coalesce(sum(${invoices.sgstAmount}), 0)`,
          outputIgst: sql<string>`coalesce(sum(${invoices.igstAmount}), 0)`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.orgId, orgId),
            inArray(invoices.status, ["ISSUED", "PAID", "OVERDUE"]),
            gte(invoices.createdAt, new Date(`${from}T00:00:00.000Z`)),
            lte(invoices.createdAt, new Date(`${to}T23:59:59.000Z`)),
          ),
        ),

      this.db
        .select({
          inputCgst: sql<string>`coalesce(sum(${purchaseBills.cgstAmount}), 0)`,
          inputSgst: sql<string>`coalesce(sum(${purchaseBills.sgstAmount}), 0)`,
          inputIgst: sql<string>`coalesce(sum(${purchaseBills.igstAmount}), 0)`,
        })
        .from(purchaseBills)
        .where(
          and(
            eq(purchaseBills.orgId, orgId),
            inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID", "PAID"]),
            gte(purchaseBills.billDate, from),
            lte(purchaseBills.billDate, to),
          ),
        ),
    ]);

    const cashBalance = bankAccounts.reduce((acc, a) => acc + Number(a.balance ?? 0), 0);

    const incomeRow = revExpRows.find((r) => r.accountType === "INCOME");
    const expenseRow = revExpRows.find((r) => r.accountType === "EXPENSE");
    const revenueThisMonth = Number(incomeRow?.totalCredit ?? 0) - Number(incomeRow?.totalDebit ?? 0);
    const expensesThisMonth = Number(expenseRow?.totalDebit ?? 0) - Number(expenseRow?.totalCredit ?? 0);
    const netProfit = revenueThisMonth - expensesThisMonth;

    const arRow = arOverdueRows[0];
    const apRow = apDueRows[0];

    const reconGaps = Number(reconGapRows[0]?.cnt ?? 0);
    const openApprovals = Number(openApprovalRows[0]?.cnt ?? 0);

    const trendMap = new Map<string, { revenue: number; expenses: number }>();
    for (const row of trendRows) {
      const key = row.month ?? "";
      const entry = trendMap.get(key) ?? { revenue: 0, expenses: 0 };
      if (row.accountType === "INCOME") {
        entry.revenue += Number(row.totalCredit ?? 0) - Number(row.totalDebit ?? 0);
      } else if (row.accountType === "EXPENSE") {
        entry.expenses += Number(row.totalDebit ?? 0) - Number(row.totalCredit ?? 0);
      }
      trendMap.set(key, entry);
    }
    const monthlyTrend = Array.from(trendMap.entries()).map(([month, data]) => ({
      month,
      revenue: data.revenue.toFixed(2),
      expenses: data.expenses.toFixed(2),
    }));

    const outTax = outputTaxRows[0];
    const inTax = inputTaxRows[0];
    const taxPayable =
      Number(outTax?.outputCgst ?? 0) +
      Number(outTax?.outputSgst ?? 0) +
      Number(outTax?.outputIgst ?? 0) -
      Number(inTax?.inputCgst ?? 0) -
      Number(inTax?.inputSgst ?? 0) -
      Number(inTax?.inputIgst ?? 0);

    const burnRows3m = burnRows[0];
    const burnRaw = burnRows3m[0];
    const totalExpense3m = Number(burnRaw?.totalDebit ?? 0) - Number(burnRaw?.totalCredit ?? 0);
    const averageBurnRate = totalExpense3m > 0 ? totalExpense3m / 3 : 0;
    const runwayMonths =
      averageBurnRate > 0 ? Math.floor(cashBalance / averageBurnRate) : null;

    const drill: Record<string, { type: string; params: Record<string, string> }> = {
      arOverdue: { type: "invoices", params: { status: "OVERDUE" } },
      apDueNext7: { type: "purchase-bills", params: { status: "POSTED,PARTIALLY_PAID", dueBefore: addDays(today, 7) } },
      reconGaps: { type: "bank-transactions", params: { status: "UNMATCHED,SUGGESTED" } },
      openApprovals: { type: "approvals", params: { status: "PENDING" } },
    };

    return {
      cashBalance: cashBalance.toFixed(2),
      bankAccounts: bankAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        balance: Number(a.balance ?? 0).toFixed(2),
      })),
      revenueThisMonth: revenueThisMonth.toFixed(2),
      expensesThisMonth: expensesThisMonth.toFixed(2),
      netProfit: netProfit.toFixed(2),
      arOverdue: {
        count: Number(arRow?.cnt ?? 0),
        amount: Number(arRow?.total ?? 0).toFixed(2),
      },
      apDueNext7: {
        count: Number(apRow?.cnt ?? 0),
        amount: Number(apRow?.total ?? 0).toFixed(2),
      },
      taxPayable: taxPayable.toFixed(2),
      burnRate: averageBurnRate.toFixed(2),
      runwayMonths,
      reconciliationGaps: reconGaps,
      openApprovals,
      monthlyTrend,
      drill,
      period: { from, to },
    };
  }
}
