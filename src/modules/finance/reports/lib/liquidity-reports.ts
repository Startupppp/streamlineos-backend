/**
 * The cash-position family: working capital, burn rate and runway.
 *
 * These three are one report read three ways, and they are the only ones in the
 * analytics set that are anchored to *now* rather than to a caller-supplied
 * window — `burnRate` hard-codes the previous three whole months and `cashRunway`
 * projects forward from today, which is why the month arithmetic lives here and
 * nowhere else. `cashRunway` consumes `computeBurnRate` directly rather than the
 * cached wrapper, so a runway is always computed against the burn figure from the
 * same instant.
 *
 * Working capital's current-vs-noncurrent split is by account CODE
 * (assets below 1500, liabilities below 2500), not by a flag; that is the chart
 * of accounts convention this codebase uses and it moved untouched.
 *
 * MONEY: decimal(x,2) sums read back as strings and rendered with toFixed(2) —
 * the finance-report convention, not the GL kernel's integer *_minor units.
 * Moved from analytics-reports.service.ts character for character.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  finBankAccounts,
  ledgerAccounts,
  journalEntries,
  journalLines,
} from "../../../../db/schema";
import type { AnalyticsReportDeps } from "./profitability-reports";

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

export async function computeWorkingCapital(
  deps: AnalyticsReportDeps,
  orgId: string,
  asOf: string,
) {
  const [assetRows, liabilityRows] = await Promise.all([
    deps.db
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

    deps.db
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

export async function computeBurnRate(
  deps: AnalyticsReportDeps,
  orgId: string,
) {
  const months: Array<{ label: string; from: string; to: string }> = [
    { label: monthStart(3).slice(0, 7), from: monthStart(3), to: monthEnd(3) },
    { label: monthStart(2).slice(0, 7), from: monthStart(2), to: monthEnd(2) },
    { label: monthStart(1).slice(0, 7), from: monthStart(1), to: monthEnd(1) },
  ];

  const monthData = await Promise.all(
    months.map(({ label, from, to }) =>
      deps.db
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

export async function computeCashRunway(
  deps: AnalyticsReportDeps,
  orgId: string,
  months: number,
) {
  const bankRows = await deps.db
    .select({ balance: finBankAccounts.currentBalance })
    .from(finBankAccounts)
    .where(and(eq(finBankAccounts.orgId, orgId), eq(finBankAccounts.isActive, true)));

  const cashBalance = bankRows.reduce((acc, r) => acc + Number(r.balance ?? 0), 0);

  const burnData = await computeBurnRate(deps, orgId);
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
