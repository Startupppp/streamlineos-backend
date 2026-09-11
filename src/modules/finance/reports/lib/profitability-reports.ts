/**
 * Profitability by project and by department.
 *
 * Both answer the same question — revenue minus cost for one slice of the
 * ledger — and both carry the same trap: revenue is credit-minus-debit while
 * cost is debit-minus-credit, so the two sides are NOT symmetric and cannot be
 * folded into one helper without one of them coming out negated. The project
 * variant additionally adds approved and paid rows from `expenses`, because a
 * reimbursable cost charged to a project may not have reached the GL yet;
 * the department variant deliberately does not, since expenses carry no
 * department.
 *
 * MONEY: these are decimal(x,2) column sums read back as strings, summed in
 * Postgres and rendered with toFixed(2) — the finance-report convention, not
 * the GL kernel's integer *_minor units. Every line moved from
 * analytics-reports.service.ts character for character.
 */
import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  ledgerAccounts,
  journalEntries,
  journalLines,
  expenses,
  orgUnits,
  projects,
} from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";

export interface AnalyticsReportDeps {
  readonly db: Db;
}

export async function computeProjectProfitability(
  deps: AnalyticsReportDeps,
  orgId: string,
  from: string,
  to: string,
) {
  const [revenueRows, costJournalRows, costExpenseRows] = await Promise.all([
    deps.db
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

    deps.db
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

    deps.db
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

  const projectRows = await deps.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), inArray(projects.id, Array.from(allProjectIds))));
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

export async function computeDeptProfitability(
  deps: AnalyticsReportDeps,
  orgId: string,
  from: string,
  to: string,
) {
  const [revenueRows, costRows] = await Promise.all([
    deps.db
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

    deps.db
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

  const deptRows = await deps.db
    .select({ id: orgUnits.id, name: orgUnits.name })
    .from(orgUnits)
    .where(and(eq(orgUnits.orgId, orgId), inArray(orgUnits.id, Array.from(allDeptIds))));
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
