import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  invoices,
  purchaseBills,
  finRecurringInvoiceTemplates,
  finRecurringBillTemplates,
  finBankAccounts,
  journalLines,
  journalEntries,
  accSystemAccountMap,
  finCashFlowScenarios,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { baseCreditAmount } from "../../accounting/core/journal-base-amount";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import {
  addDecimals,
  subtractDecimals,
  multiplyDecimals,
  compareDecimals,
} from "../../accounting/core/money.util";
import type {
  ForecastQuery,
  CompareScenariosQuery,
  ScenarioAssumptions,
} from "./dto/finance-planning.schemas";
import type {
  ForecastResponse,
  ForecastWeek,
  ScenarioCompareResponse,
} from "./finance-planning.types";

const FORECAST_TTL = 120;

const DEFAULT_ASSUMPTIONS: ScenarioAssumptions = {
  collectionRatePct: 90,
  payDelayDays: 0,
  revenueGrowthPct: 0,
  plannedSpend: [],
};

function isoDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + n);
  return r;
}

function addWeeks(d: Date, n: number): Date {
  return addDays(d, n * 7);
}

function weekBounds(start: Date, i: number) {
  const s = addWeeks(start, i);
  const e = addDays(addWeeks(start, i + 1), -1);
  return { weekStart: isoDateStr(s), weekEnd: isoDateStr(e), s, e };
}

function findWeekIdx(date: Date, windowStart: Date, total: number): number | null {
  for (let i = 0; i < total; i++) {
    const { s, e } = weekBounds(windowStart, i);
    if (date >= s && date <= e) return i;
  }
  return null;
}

function parseAssumptions(raw: unknown): ScenarioAssumptions {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ASSUMPTIONS };
  const r = raw as Record<string, unknown>;
  return {
    collectionRatePct: typeof r.collectionRatePct === "number" ? r.collectionRatePct : 90,
    payDelayDays: typeof r.payDelayDays === "number" ? r.payDelayDays : 0,
    revenueGrowthPct: typeof r.revenueGrowthPct === "number" ? r.revenueGrowthPct : 0,
    plannedSpend: Array.isArray(r.plannedSpend)
      ? r.plannedSpend.map((item) => {
          const i = item as Record<string, unknown>;
          return {
            label: typeof i.label === "string" ? i.label : "",
            amount: typeof i.amount === "number" ? i.amount : 0,
            startWeek: typeof i.startWeek === "number" ? i.startWeek : 0,
            recurringWeekly: typeof i.recurringWeekly === "boolean" ? i.recurringWeekly : false,
          };
        })
      : [],
  };
}

function frequencyDays(f: string): number {
  if (f === "WEEKLY") return 7;
  if (f === "MONTHLY") return 30;
  if (f === "QUARTERLY") return 91;
  if (f === "YEARLY") return 365;
  return 30;
}

function occurrencesInWindow(
  nextRunDateStr: string | null,
  endDateStr: string | null,
  frequency: string,
  windowEnd: Date,
): Date[] {
  if (!nextRunDateStr) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = endDateStr ? new Date(endDateStr) : null;
  const step = frequencyDays(frequency);
  const result: Date[] = [];
  let cur = new Date(nextRunDateStr);
  while (cur <= windowEnd) {
    if (endDate && cur > endDate) break;
    if (cur >= today) result.push(new Date(cur));
    cur = addDays(cur, step);
  }
  return result;
}

function accumulateAmounts(
  buckets: string[],
  amount: string,
  weekIdx: number,
): void {
  buckets[weekIdx] = addDecimals(buckets[weekIdx] ?? "0.0000", amount);
}

@Injectable()
export class ForecastService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getForecast(
    orgId: string,
    query: ForecastQuery,
  ): Promise<ForecastResponse> {
    const weeks = query.weeks ?? 13;
    return this.cache.cachedVersioned<ForecastResponse>(
      CACHE_KEYS.finForecastNamespace(orgId),
      `${query.scenarioId ?? "default"}:${weeks}`,
      () => this.buildForecast(orgId, query.scenarioId, weeks),
      FORECAST_TTL,
    );
  }

  private async buildForecast(
    orgId: string,
    scenarioId: number | undefined,
    weeks: number,
  ): Promise<ForecastResponse> {
    const [assumptions, resolvedScenarioId] = await Promise.all([
      this.resolveAssumptions(orgId, scenarioId),
      this.resolveScenarioId(orgId, scenarioId),
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowEnd = addWeeks(today, weeks);
    const todayStr = isoDateStr(today);

    const [balanceRows, openInvRows, recurInvTmpls, openBillRows, recurBillTmpls, payrollEst] =
      await Promise.all([
        this.db
          .select({ balance: finBankAccounts.currentBalance })
          .from(finBankAccounts)
          .where(and(eq(finBankAccounts.orgId, orgId), eq(finBankAccounts.isActive, true))),
        this.db
          .select({ total: invoices.total, amountPaid: invoices.amountPaid, dueDate: invoices.dueDate })
          .from(invoices)
          .where(and(eq(invoices.orgId, orgId), inArray(invoices.status, ["SENT", "OVERDUE", "PARTIALLY_PAID"]))),
        this.db
          .select({
            nextRunDate: finRecurringInvoiceTemplates.nextRunDate,
            endDate: finRecurringInvoiceTemplates.endDate,
            frequency: finRecurringInvoiceTemplates.frequency,
            payload: finRecurringInvoiceTemplates.payload,
          })
          .from(finRecurringInvoiceTemplates)
          .where(
            and(
              eq(finRecurringInvoiceTemplates.orgId, orgId),
              eq(finRecurringInvoiceTemplates.isActive, true),
              or(isNull(finRecurringInvoiceTemplates.endDate), sql`${finRecurringInvoiceTemplates.endDate} >= ${todayStr}`),
            ),
          ),
        this.db
          .select({ total: purchaseBills.total, amountPaid: purchaseBills.amountPaid, dueDate: purchaseBills.dueDate })
          .from(purchaseBills)
          .where(and(eq(purchaseBills.orgId, orgId), inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID"]))),
        this.db
          .select({
            nextRunDate: finRecurringBillTemplates.nextRunDate,
            endDate: finRecurringBillTemplates.endDate,
            frequency: finRecurringBillTemplates.frequency,
            payload: finRecurringBillTemplates.payload,
          })
          .from(finRecurringBillTemplates)
          .where(
            and(
              eq(finRecurringBillTemplates.orgId, orgId),
              eq(finRecurringBillTemplates.isActive, true),
              or(isNull(finRecurringBillTemplates.endDate), sql`${finRecurringBillTemplates.endDate} >= ${todayStr}`),
            ),
          ),
        this.getMonthlyPayrollEstimate(orgId),
      ]);

    const openingCash = balanceRows.reduce(
      (acc, r) => addDecimals(acc, r.balance ?? "0"),
      "0.0000",
    );
    const weeklyPayroll = String(Number(payrollEst) / 4.33);

    const inflows = Array.from<string>({ length: weeks }).fill("0.0000");
    const outflows = Array.from<string>({ length: weeks }).fill("0.0000");
    const collectionRate = String(assumptions.collectionRatePct / 100);
    const payDelay = assumptions.payDelayDays;

    for (const inv of openInvRows) {
      if (!inv.dueDate) continue;
      const outstanding = subtractDecimals(inv.total ?? "0", inv.amountPaid ?? "0");
      const effectiveInflow = multiplyDecimals(outstanding, collectionRate);
      const effectiveDue = addDays(new Date(inv.dueDate), payDelay);
      const idx = findWeekIdx(effectiveDue, today, weeks);
      if (idx !== null) accumulateAmounts(inflows, effectiveInflow, idx);
    }

    for (const tmpl of recurInvTmpls) {
      const tmplTotal = String(Number((tmpl.payload as Record<string, unknown>).total ?? 0));
      const effectiveInflow = multiplyDecimals(tmplTotal, collectionRate);
      for (const occ of occurrencesInWindow(tmpl.nextRunDate, tmpl.endDate, tmpl.frequency, windowEnd)) {
        const idx = findWeekIdx(addDays(occ, payDelay), today, weeks);
        if (idx !== null) accumulateAmounts(inflows, effectiveInflow, idx);
      }
    }

    for (const bill of openBillRows) {
      if (!bill.dueDate) continue;
      const outstanding = subtractDecimals(bill.total ?? "0", bill.amountPaid ?? "0");
      const idx = findWeekIdx(new Date(bill.dueDate), today, weeks);
      if (idx !== null) accumulateAmounts(outflows, outstanding, idx);
    }

    for (const tmpl of recurBillTmpls) {
      const tmplTotal = String(Number((tmpl.payload as Record<string, unknown>).total ?? 0));
      for (const occ of occurrencesInWindow(tmpl.nextRunDate, tmpl.endDate, tmpl.frequency, windowEnd)) {
        const idx = findWeekIdx(occ, today, weeks);
        if (idx !== null) accumulateAmounts(outflows, tmplTotal, idx);
      }
    }

    for (let i = 0; i < weeks; i++) {
      if ((i + 1) % 4 === 0) accumulateAmounts(outflows, weeklyPayroll, i);
    }

    for (const spend of assumptions.plannedSpend) {
      const amtStr = String(spend.amount);
      if (spend.recurringWeekly) {
        for (let i = spend.startWeek; i < weeks; i++) accumulateAmounts(outflows, amtStr, i);
      } else if (spend.startWeek < weeks) {
        accumulateAmounts(outflows, amtStr, spend.startWeek);
      }
    }

    const forecastWeeks: ForecastWeek[] = [];
    let runningCash = openingCash;
    let totalInflows = "0.0000";
    let totalOutflows = "0.0000";

    for (let i = 0; i < weeks; i++) {
      const { weekStart, weekEnd } = weekBounds(today, i);
      const weekInflows = inflows[i] ?? "0.0000";
      const weekOutflows = outflows[i] ?? "0.0000";
      const net = subtractDecimals(weekInflows, weekOutflows);
      const closingCash = addDecimals(runningCash, net);
      forecastWeeks.push({
        weekIndex: i,
        weekStart,
        weekEnd,
        openingCash: runningCash,
        inflows: weekInflows,
        outflows: weekOutflows,
        net,
        closingCash,
        minimumBalanceWarning: compareDecimals(closingCash, "0") < 0,
      });
      runningCash = closingCash;
      totalInflows = addDecimals(totalInflows, weekInflows);
      totalOutflows = addDecimals(totalOutflows, weekOutflows);
    }

    return {
      scenarioId: resolvedScenarioId,
      generatedAt: new Date().toISOString(),
      weeks: forecastWeeks,
      totalInflows,
      totalOutflows,
    };
  }

  private async resolveAssumptions(
    orgId: string,
    scenarioId: number | undefined,
  ): Promise<ScenarioAssumptions> {
    const where = scenarioId !== undefined
      ? and(eq(finCashFlowScenarios.id, scenarioId), eq(finCashFlowScenarios.orgId, orgId))
      : and(eq(finCashFlowScenarios.orgId, orgId), eq(finCashFlowScenarios.isDefault, true));

    const rows = await this.db
      .select({ assumptions: finCashFlowScenarios.assumptions })
      .from(finCashFlowScenarios)
      .where(where)
      .limit(1);

    return rows.length > 0 ? parseAssumptions(rows[0]?.assumptions) : { ...DEFAULT_ASSUMPTIONS };
  }

  private async resolveScenarioId(
    orgId: string,
    scenarioId: number | undefined,
  ): Promise<number | null> {
    const where = scenarioId !== undefined
      ? and(eq(finCashFlowScenarios.id, scenarioId), eq(finCashFlowScenarios.orgId, orgId))
      : and(eq(finCashFlowScenarios.orgId, orgId), eq(finCashFlowScenarios.isDefault, true));

    const rows = await this.db
      .select({ id: finCashFlowScenarios.id })
      .from(finCashFlowScenarios)
      .where(where)
      .limit(1);

    return rows[0]?.id ?? null;
  }

  private async getMonthlyPayrollEstimate(orgId: string): Promise<string> {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const accountRows = await this.db
      .select({ accountId: accSystemAccountMap.accountId })
      .from(accSystemAccountMap)
      .where(and(eq(accSystemAccountMap.orgId, orgId), eq(accSystemAccountMap.purpose, "PAYROLL_PAYABLE")));

    if (accountRows.length === 0) return "0.0000";

    const accountIds = accountRows.map((r) => r.accountId);
    const rows = await this.db
      .select({ total: sql<string>`SUM(${baseCreditAmount})` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.orgId, orgId),
          eq(journalEntries.status, "POSTED"),
          inArray(journalLines.accountId, accountIds),
          sql`${journalEntries.entryDate} >= ${isoDateStr(threeMonthsAgo)}`,
        ),
      );

    const totalCredit = String(rows[0]?.total ?? "0");
    return String(Number(totalCredit) / 3);
  }

  async compareForecast(
    orgId: string,
    query: CompareScenariosQuery,
    _: string,
  ): Promise<ScenarioCompareResponse> {
    const { scenarioIds } = query;

    const [scenarioRows, forecasts] = await Promise.all([
      this.db
        .select({ id: finCashFlowScenarios.id, name: finCashFlowScenarios.name, kind: finCashFlowScenarios.kind })
        .from(finCashFlowScenarios)
        .where(and(eq(finCashFlowScenarios.orgId, orgId), inArray(finCashFlowScenarios.id, scenarioIds))),
      Promise.all(
        scenarioIds.map((sid) =>
          this.getForecast(orgId, { weeks: 13, scenarioId: sid }),
        ),
      ),
    ]);

    const weekCount = forecasts[0]?.weeks.length ?? 13;
    const comparedWeeks = Array.from({ length: weekCount }, (_, i) => {
      const closingCash: Record<number, string> = {};
      for (let j = 0; j < scenarioIds.length; j++) {
        const sid = scenarioIds[j];
        const week = forecasts[j]?.weeks[i];
        if (sid !== undefined && week !== undefined) closingCash[sid] = week.closingCash;
      }
      return { weekIndex: i, weekStart: forecasts[0]?.weeks[i]?.weekStart ?? "", closingCash };
    });

    return {
      scenarioIds,
      scenarios: scenarioRows.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      weeks: comparedWeeks,
    };
  }
}
