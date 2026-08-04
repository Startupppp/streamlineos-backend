import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { finBudgets, finBudgetLines, journalLines, journalEntries, ledgerAccounts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { addDecimals, subtractDecimals, compareDecimals, formatDecimal } from "../../accounting/core/money.util";
import type { BvaQuery } from "./dto/finance-planning.schemas";
import type { BvaResponse, BvaAccountPeriodRow } from "./finance-planning.types";

const exceededNotifiedSet = new Set<string>();

function computeVariancePct(actual: string, budgeted: string): string {
  const b = Number(budgeted);
  if (b === 0) return "0.0000";
  const pct = Math.round((Number(actual) / b) * 100 * 100) / 100;
  return formatDecimal(String(pct), 4);
}

function absActual(debit: string, credit: string): string {
  const d = debit || "0";
  const c = credit || "0";
  return compareDecimals(d, c) >= 0
    ? subtractDecimals(d, c)
    : subtractDecimals(c, d);
}

@Injectable()
export class BvaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async getBva(orgId: string, budgetId: number, query: BvaQuery, requesterId: string): Promise<BvaResponse> {
    const [budget] = await this.db
      .select()
      .from(finBudgets)
      .where(and(eq(finBudgets.id, budgetId), eq(finBudgets.orgId, orgId)))
      .limit(1);

    if (!budget) {
      throw new NotFoundException(`Budget ${budgetId} not found`);
    }

    const cacheKey = `${query.from ?? ""}:${query.to ?? ""}`;

    return this.cache.cachedVersioned<BvaResponse>(
      CACHE_KEYS.finBvaNamespace(orgId, budgetId),
      cacheKey,
      () => this.computeBva(orgId, budgetId, budget, query, requesterId),
      60,
    );
  }

  private async computeBva(
    orgId: string,
    budgetId: number,
    budget: typeof finBudgets.$inferSelect,
    query: BvaQuery,
    requesterId: string,
  ): Promise<BvaResponse> {
    const budgetLineRows = await this.db
      .select()
      .from(finBudgetLines)
      .where(and(eq(finBudgetLines.budgetId, budgetId), eq(finBudgetLines.orgId, orgId)));

    const budgetMap = new Map<string, string>();
    const accountIds: number[] = [];

    for (const line of budgetLineRows) {
      const key = `${line.accountId}:${line.periodKey}`;
      budgetMap.set(key, String(line.amount ?? "0"));
      if (!accountIds.includes(line.accountId)) {
        accountIds.push(line.accountId);
      }
    }

    const periodExpr =
      budget.periodType === "MONTHLY"
        ? sql<string>`to_char(${journalEntries.entryDate}, 'YYYY-MM')`
        : budget.periodType === "QUARTERLY"
          ? sql<string>`to_char(${journalEntries.entryDate}, 'YYYY') || '-Q' || to_char(CEIL(EXTRACT(MONTH FROM ${journalEntries.entryDate}::date) / 3.0), 'FM9')`
          : sql<string>`to_char(${journalEntries.entryDate}, 'YYYY')`;

    const conditions = [
      eq(journalEntries.orgId, orgId),
      eq(journalEntries.status, "POSTED"),
      ...(query.from ? [sql`${journalEntries.entryDate} >= ${query.from}`] : []),
      ...(query.to ? [sql`${journalEntries.entryDate} <= ${query.to}`] : []),
      ...(accountIds.length > 0 ? [inArray(journalLines.accountId, accountIds)] : []),
    ];

    const actuals = await this.db
      .select({
        accountId: journalLines.accountId,
        periodKey: periodExpr,
        debit: sql<string>`SUM(${journalLines.debit})`,
        credit: sql<string>`SUM(${journalLines.credit})`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...conditions))
      .groupBy(journalLines.accountId, periodExpr);

    const actualMap = new Map<string, string>();
    for (const row of actuals) {
      const acctId = Number(row.accountId ?? 0);
      const period = String(row.periodKey ?? "");
      const key = `${acctId}:${period}`;
      actualMap.set(key, absActual(String(row.debit ?? "0"), String(row.credit ?? "0")));
    }

    const accountRows =
      accountIds.length > 0
        ? await this.db
            .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.orgId, orgId), inArray(ledgerAccounts.id, accountIds)))
        : [];

    const accountMap = new Map(accountRows.map((a) => [a.id, { code: a.code, name: a.name }]));

    const rows: BvaAccountPeriodRow[] = [];
    let totalBudgeted = "0.0000";
    let totalActual = "0.0000";

    for (const line of budgetLineRows) {
      const key = `${line.accountId}:${line.periodKey}`;
      const budgeted = formatDecimal(String(line.amount ?? "0"), 4);
      const actual = formatDecimal(actualMap.get(key) ?? "0", 4);
      const variance = subtractDecimals(budgeted, actual);
      const variancePct = computeVariancePct(actual, budgeted);
      const exceeded = compareDecimals(actual, budgeted) > 0;

      const acct = accountMap.get(line.accountId);

      rows.push({
        accountId: line.accountId,
        accountCode: acct?.code ?? "",
        accountName: acct?.name ?? "",
        periodKey: line.periodKey,
        budgeted,
        actual,
        variance,
        variancePct,
        exceeded,
      });

      totalBudgeted = addDecimals(totalBudgeted, budgeted);
      totalActual = addDecimals(totalActual, actual);

      if (exceeded) {
        const notifKey = `${budgetId}:${line.accountId}:${line.periodKey}`;
        if (!exceededNotifiedSet.has(notifKey)) {
          exceededNotifiedSet.add(notifKey);
          void this.dispatch.emit({
            eventKey: "accounting.budget.exceeded",
            orgId,
            actorUserId: null,
            targetUserIds: [requesterId],
            entityType: "budget",
            entityId: String(budgetId),
            variables: {
              accountId: line.accountId,
              accountCode: acct?.code ?? "",
              periodKey: line.periodKey,
              budgeted,
              actual,
            },
          });
        }
      }
    }

    const totalVariance = subtractDecimals(totalBudgeted, totalActual);
    const totalVariancePct = computeVariancePct(totalActual, totalBudgeted);

    return {
      budgetId,
      from: query.from ?? null,
      to: query.to ?? null,
      rows,
      totals: {
        budgeted: totalBudgeted,
        actual: totalActual,
        variance: totalVariance,
        variancePct: totalVariancePct,
      },
    };
  }
}
