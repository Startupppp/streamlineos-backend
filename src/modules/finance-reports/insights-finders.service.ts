import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import {
  expenses,
  expenseCategories,
  purchaseBills,
  journalEntries,
  journalLines,
  ledgerAccounts,
  invoices,
  clients,
  finBankAccounts,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { AnomalyFinding } from "./dto/insights.schemas";

export function stableHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}

export function monthStart(monthsAgo: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1))
    .toISOString()
    .slice(0, 10);
}

export function monthEnd(monthsAgo: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 0))
    .toISOString()
    .slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function stddev(values: number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

@Injectable()
export class InsightsFindersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async findExpenseSpikes(orgId: string, from: string, to: string): Promise<AnomalyFinding[]> {
    const sixMonthsAgo = monthStart(6);
    const rows = await this.db
      .select({
        categoryId: expenses.categoryId,
        categoryName: expenseCategories.name,
        monthKey: sql<string>`to_char(date_trunc('month', ${expenses.expenseDate}::date), 'YYYY-MM')`,
        total: sql<string>`coalesce(sum(${expenses.amount}), 0)`,
      })
      .from(expenses)
      .leftJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .where(
        and(
          eq(expenses.orgId, orgId),
          inArray(expenses.status, ["APPROVED", "PAID"]),
          gte(expenses.expenseDate, sixMonthsAgo),
          lte(expenses.expenseDate, to),
        ),
      )
      .groupBy(
        expenses.categoryId,
        expenseCategories.name,
        sql`date_trunc('month', ${expenses.expenseDate}::date)`,
      );

    const currentMonthKey = from.slice(0, 7);
    type MonthlyBucket = { monthKey: string; total: number };
    const byCategory = new Map<number | null, { name: string; months: MonthlyBucket[] }>();

    for (const row of rows) {
      const catId = row.categoryId;
      const name = row.categoryName ?? `Category ${String(catId ?? "unknown")}`;
      const total = Number(row.total ?? 0);
      const monthKey = row.monthKey ?? "";
      if (!byCategory.has(catId)) byCategory.set(catId, { name, months: [] });
      byCategory.get(catId)!.months.push({ monthKey, total });
    }

    const findings: AnomalyFinding[] = [];
    const AMOUNT_FLOOR = 1000;

    for (const [catId, { name, months }] of byCategory.entries()) {
      const current = months.find((m) => m.monthKey === currentMonthKey);
      if (!current || current.total < AMOUNT_FLOOR) continue;
      const history = months.filter((m) => m.monthKey !== currentMonthKey).map((m) => m.total);
      if (history.length < 3) continue;

      const { mean, sd } = stddev(history);
      const threshold = mean + 2 * sd;
      if (current.total > threshold && threshold > 0) {
        const pct = mean > 0 ? Math.round(((current.total - mean) / mean) * 100) : 0;
        findings.push({
          id: stableHash(`EXPENSE_SPIKE:${orgId}:${String(catId)}:${currentMonthKey}`),
          severity: pct > 100 ? "critical" : "warning",
          kind: "EXPENSE_SPIKE",
          title: `Expense spike in ${name}`,
          detail: `${name} spend of ${current.total.toLocaleString()} is ${pct}% above the 6-month average of ${Math.round(mean).toLocaleString()}.`,
          drill: { type: "expenses", params: { categoryId: catId ?? "", month: currentMonthKey } },
        });
      }
    }
    return findings;
  }

  async findDuplicateBills(orgId: string, from: string, to: string): Promise<AnomalyFinding[]> {
    const rows = await this.db
      .select({
        vendorId: purchaseBills.vendorId,
        vendorName: clients.name,
        total: purchaseBills.total,
        billDate: purchaseBills.billDate,
        billId: purchaseBills.id,
        billNumber: purchaseBills.billNumber,
      })
      .from(purchaseBills)
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(
        and(
          eq(purchaseBills.orgId, orgId),
          ne(purchaseBills.status, "CANCELLED"),
          gte(purchaseBills.billDate, from),
          lte(purchaseBills.billDate, to),
        ),
      )
      .orderBy(purchaseBills.vendorId, purchaseBills.total, purchaseBills.billDate);

    const findings: AnomalyFinding[] = [];
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]!;
      const b = rows[i + 1]!;
      if (a.vendorId !== null && a.vendorId === b.vendorId && Number(a.total) === Number(b.total)) {
        const daysApart =
          Math.abs(new Date(b.billDate).getTime() - new Date(a.billDate).getTime()) /
          (1000 * 60 * 60 * 24);
        if (daysApart <= 7) {
          const vendorLabel = a.vendorName ?? `Vendor ${String(a.vendorId)}`;
          findings.push({
            id: stableHash(`DUPLICATE_BILL_SUSPECT:${orgId}:${String(a.billId)}:${String(b.billId)}`),
            severity: "warning",
            kind: "DUPLICATE_BILL_SUSPECT",
            title: `Possible duplicate bill from ${vendorLabel}`,
            detail: `Bills #${a.billNumber} and #${b.billNumber} from ${vendorLabel} have the same amount (${Number(a.total).toLocaleString()}) and are ${Math.round(daysApart)} day(s) apart.`,
            drill: { type: "purchase-bills", params: { vendorId: a.vendorId, ids: `${a.billId},${b.billId}` } },
          });
          i++;
        }
      }
    }
    return findings;
  }

  async findUnusualJournals(orgId: string, from: string, to: string): Promise<AnomalyFinding[]> {
    const ninetyDaysAgo = addDays(from, -90);

    const [historyRows, currentRows] = await Promise.all([
      this.db
        .select({
          entryId: journalEntries.id,
          total: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        })
        .from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.status, "POSTED"),
            inArray(journalEntries.sourceType, ["MANUAL", "manual"]),
            gte(journalEntries.entryDate, ninetyDaysAgo),
            lte(journalEntries.entryDate, from),
          ),
        )
        .groupBy(journalEntries.id),

      this.db
        .select({
          entryId: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          entryDate: journalEntries.entryDate,
          total: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        })
        .from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
        .where(
          and(
            eq(journalEntries.orgId, orgId),
            eq(journalEntries.status, "POSTED"),
            inArray(journalEntries.sourceType, ["MANUAL", "manual"]),
            gte(journalEntries.entryDate, from),
            lte(journalEntries.entryDate, to),
          ),
        )
        .groupBy(journalEntries.id, journalEntries.entryNumber, journalEntries.entryDate),
    ]);

    const historyTotals = historyRows
      .map((r) => Number(r.total ?? 0))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    if (historyTotals.length === 0) return [];

    const p95 = percentile(historyTotals, 95);
    return currentRows
      .filter((r) => Number(r.total ?? 0) > p95 && p95 > 0)
      .map((r) => ({
        id: stableHash(`UNUSUAL_JOURNAL:${orgId}:${String(r.entryId)}`),
        severity: "warning" as const,
        kind: "UNUSUAL_JOURNAL" as const,
        title: "Unusually large manual journal entry",
        detail: `Journal #${r.entryNumber} dated ${String(r.entryDate)} totals ${Number(r.total ?? 0).toLocaleString()}, above the 90-day p95 threshold of ${Math.round(p95).toLocaleString()}.`,
        drill: { type: "journal-entries", params: { entryId: r.entryId } },
      }));
  }

  async findRoundAmountPatterns(orgId: string, from: string, to: string): Promise<AnomalyFinding[]> {
    const rows = await this.db
      .select({
        vendorId: purchaseBills.vendorId,
        vendorName: clients.name,
        total: purchaseBills.total,
      })
      .from(purchaseBills)
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(
        and(
          eq(purchaseBills.orgId, orgId),
          ne(purchaseBills.status, "CANCELLED"),
          gte(purchaseBills.billDate, from),
          lte(purchaseBills.billDate, to),
          sql`(${purchaseBills.total}::numeric % 100) = 0`,
          sql`${purchaseBills.total}::numeric > 0`,
        ),
      );

    const byKey = new Map<string, { vendorId: number; vendorName: string; count: number; amount: number }>();
    for (const row of rows) {
      if (row.vendorId === null) continue;
      const key = `${String(row.vendorId)}:${row.total}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count++;
      } else {
        byKey.set(key, {
          vendorId: row.vendorId,
          vendorName: row.vendorName ?? `Vendor ${String(row.vendorId)}`,
          count: 1,
          amount: Number(row.total),
        });
      }
    }

    return Array.from(byKey.entries())
      .filter(([, v]) => v.count >= 3)
      .map(([key, { vendorId, vendorName, count, amount }]) => ({
        id: stableHash(`ROUND_AMOUNT_PATTERN:${orgId}:${key}`),
        severity: "info" as const,
        kind: "ROUND_AMOUNT_PATTERN" as const,
        title: `Round-amount repeat payments to ${vendorName}`,
        detail: `${vendorName} has ${count} bills of exactly ${amount.toLocaleString()} — may indicate a recurring subscription or duplicate.`,
        drill: { type: "purchase-bills", params: { vendorId, amount: amount.toString() } },
      }));
  }

  async findArConcentration(orgId: string): Promise<AnomalyFinding[]> {
    const rows = await this.db
      .select({
        clientId: invoices.clientId,
        clientName: clients.name,
        openAr: sql<string>`coalesce(sum(${invoices.total} - ${invoices.amountPaid}), 0)`,
      })
      .from(invoices)
      .leftJoin(clients, eq(clients.id, invoices.clientId))
      .where(
        and(
          eq(invoices.orgId, orgId),
          inArray(invoices.status, ["ISSUED", "OVERDUE", "PARTIALLY_PAID"]),
        ),
      )
      .groupBy(invoices.clientId, clients.name);

    const totalAr = rows.reduce((acc, r) => acc + Number(r.openAr ?? 0), 0);
    if (totalAr <= 0) return [];

    return rows
      .filter((r) => Number(r.openAr ?? 0) / totalAr > 0.4)
      .map((r) => {
        const amount = Number(r.openAr ?? 0);
        const pct = Math.round((amount / totalAr) * 100);
        const label = r.clientName ?? `Client ${String(r.clientId)}`;
        return {
          id: stableHash(`AR_CONCENTRATION:${orgId}:${String(r.clientId)}`),
          severity: "info" as const,
          kind: "AR_CONCENTRATION" as const,
          title: `High AR concentration — ${label}`,
          detail: `${label} accounts for ${pct}% of open AR (${amount.toLocaleString()} of ${Math.round(totalAr).toLocaleString()} total).`,
          drill: { type: "invoices", params: { clientId: r.clientId ?? "", status: "ISSUED,OVERDUE" } },
        };
      });
  }

  async findCashDipProjected(orgId: string): Promise<AnomalyFinding[]> {
    const [bankRows, burnRows] = await Promise.all([
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

    const cashBalance = bankRows.reduce((acc, r) => acc + Number(r.balance ?? 0), 0);
    const totalExpense3m =
      Number(burnRows[0]?.totalDebit ?? 0) - Number(burnRows[0]?.totalCredit ?? 0);
    const avgBurn = totalExpense3m > 0 ? totalExpense3m / 3 : 0;
    if (avgBurn <= 0 || cashBalance <= 0) return [];

    const runwayMonths = cashBalance / avgBurn;
    if (runwayMonths >= 3) return [];

    return [
      {
        id: stableHash(`CASH_DIP_PROJECTED:${orgId}`),
        severity: "warning" as const,
        kind: "CASH_DIP_PROJECTED" as const,
        title: "Cash runway below 3 months",
        detail: `At the current burn rate of ${Math.round(avgBurn).toLocaleString()}/month, cash reserves of ${Math.round(cashBalance).toLocaleString()} cover approximately ${runwayMonths.toFixed(1)} months.`,
        drill: { type: "cash-runway", params: { months: "6" } },
      },
    ];
  }
}
