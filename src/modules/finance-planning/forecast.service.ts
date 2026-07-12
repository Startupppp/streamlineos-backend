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
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import {
  addDecimals,
  subtractDecimals,
  multiplyDecimals,
  compareDecimals,
} from "../accounting/money.util";
import type {
  ForecastQuery,
  CompareScenariosQuery,
} from "./dto/finance-planning.schemas";
import type {
  ForecastResponse,
  ForecastWeek,
  ScenarioCompareResponse,
  ScenarioAssumptions,
} from "./finance-planning.types";

const FORECAST_CACHE_KEY = (
  orgId: string,
  scenarioId?: number,
  weeks?: number,
) => `fin:forecast:${orgId}:${scenarioId ?? "default"}:${weeks ?? 13}`;

const FORECAST_CACHE_TTL = 120;

const DEFAULT_ASSUMPTIONS: ScenarioAssumptions = {
  collectionRatePct: 90,
  payDelayDays: 0,
  revenueGrowthPct: 0,
  plannedSpend: [],
};

function isoDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addWeeks(d: Date, n: number): Date {
  const result = new Date(d.getTime());
  result.setDate(result.getDate() + n * 7);
  return result;
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d.getTime());
  result.setDate(result.getDate() + n);
  return result;
}

function weekRange(
  startDate: Date,
  weekIndex: number,
): {
  weekStart: string;
  weekEnd: string;
  dueDateStart: Date;
  dueDateEnd: Date;
} {
  const dueDateStart = addWeeks(startDate, weekIndex);
  const dueDateEnd = addDays(addWeeks(startDate, weekIndex + 1), -1);
  return {
    weekStart: isoDateStr(dueDateStart),
    weekEnd: isoDateStr(dueDateEnd),
    dueDateStart,
    dueDateEnd,
  };
}

function parseAssumptions(raw: unknown): ScenarioAssumptions {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_ASSUMPTIONS };
  }
  const r = raw as Record<string, unknown>;
  return {
    collectionRatePct:
      typeof r.collectionRatePct === "number" ? r.collectionRatePct : 90,
    payDelayDays:
      typeof r.payDelayDays === "number" ? r.payDelayDays : 0,
    revenueGrowthPct:
      typeof r.revenueGrowthPct === "number" ? r.revenueGrowthPct : 0,
    plannedSpend: Array.isArray(r.plannedSpend)
      ? r.plannedSpend.map((item) => {
          const i = item as Record<string, unknown>;
          return {
            label: typeof i.label === "string" ? i.label : "",
            amount: typeof i.amount === "number" ? i.amount : 0,
            startWeek: typeof i.startWeek === "number" ? i.startWeek : 0,
            recurringWeekly:
              typeof i.recurringWeekly === "boolean"
                ? i.recurringWeekly
                : false,
          };
        })
      : [],
  };
}

function frequencyDays(frequency: string): number {
  if (frequency === "WEEKLY") return 7;
  if (frequency === "MONTHLY") return 30;
  if (frequency === "QUARTERLY") return 91;
  if (frequency === "YEARLY") return 365;
  return 30;
}

function getOccurrencesInWindow(
  nextRunDateStr: string | null,
  endDateStr: string | null,
  frequency: string,
  windowEnd: Date,
): Date[] {
  if (!nextRunDateStr) return [];
  const occurrences: Date[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let current = new Date(nextRunDateStr);
  const endDate = endDateStr ? new Date(endDateStr) : null;
  const stepDays = frequencyDays(frequency);
  while (current <= windowEnd) {
    if (endDate && current > endDate) break;
    if (current >= today) {
      occurrences.push(new Date(current));
    }
    current = addDays(current, stepDays);
  }
  return occurrences;
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
    _requesterId: string,
  ): Promise<ForecastResponse> {
    const weeks = query.weeks ?? 13;
    const cacheKey = FORECAST_CACHE_KEY(orgId, query.scenarioId, weeks);

    return this.cache.cached<ForecastResponse>(
      cacheKey,
      () => this.buildForecast(orgId, query.scenarioId, weeks),
      FORECAST_CACHE_TTL,
    );
  }

  private async buildForecast(
    orgId: string,
    scenarioId: number | undefined,
    weeks: number,
  ): Promise<ForecastResponse> {
    const assumptions = await this.resolveAssumptions(orgId, scenarioId);
    const resolvedScenarioId = await this.resolveScenarioId(
      orgId,
      scenarioId,
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowEnd = addWeeks(today, weeks);

    const [
      openingCash,
      openInvoiceRows,
      recurringInvoiceTemplates,
      openBillRows,
      recurringBillTemplates,
      monthlyPayrollEstimate,
    ] = await Promise.all([
      this.getOpeningCash(orgId),
      this.getOpenInvoices(orgId),
      this.getRecurringInvoiceTemplates(orgId, today),
      this.getOpenBills(orgId),
      this.getRecurringBillTemplates(orgId, today),
      this.getMonthlyPayrollEstimate(orgId),
    ]);

    const weeklyPayrollEstimate = String(
      Number(monthlyPayrollEstimate) / 4.33,
    );

    const inflowsByWeek: string[] = Array.from({ length: weeks }, () => "0.0000");
    const outflowsByWeek: string[] = Array.from(
      { length: weeks },
      () => "0.0000",
    );

    const collectionRate = String(assumptions.collectionRatePct / 100);
    const payDelay = assumptions.payDelayDays;

    for (const inv of openInvoiceRows) {
      const outstanding = subtractDecimals(
        inv.total ?? "0",
        inv.amountPaid ?? "0",
      );
      const effectiveInflow = multiplyDecimals(outstanding, collectionRate);
      if (!inv.dueDate) continue;
      const rawDue = new Date(inv.dueDate);
      const effectiveDue = addDays(rawDue, payDelay);
      const weekIdx = this.findWeekIndex(effectiveDue, today, weeks);
      if (weekIdx !== null) {
        inflowsByWeek[weekIdx] = addDecimals(
          inflowsByWeek[weekIdx] ?? "0.0000",
          effectiveInflow,
        );
      }
    }

    for (const tmpl of recurringInvoiceTemplates) {
      const tmplTotal = Number(
        (tmpl.payload as Record<string, unknown>).total ?? 0,
      );
      const tmplTotalStr = String(tmplTotal);
      const effectiveInflow = multiplyDecimals(tmplTotalStr, collectionRate);
      const occurrences = getOccurrencesInWindow(
        tmpl.nextRunDate,
        tmpl.endDate,
        tmpl.frequency,
        windowEnd,
      );
      for (const occ of occurrences) {
        const effectiveDue = addDays(occ, payDelay);
        const weekIdx = this.findWeekIndex(effectiveDue, today, weeks);
        if (weekIdx !== null) {
          inflowsByWeek[weekIdx] = addDecimals(
            inflowsByWeek[weekIdx] ?? "0.0000",
            effectiveInflow,
          );
        }
      }
    }

    for (const bill of openBillRows) {
      const outstanding = subtractDecimals(
        bill.total ?? "0",
        bill.amountPaid ?? "0",
      );
      if (!bill.dueDate) continue;
      const due = new Date(bill.dueDate);
      const weekIdx = this.findWeekIndex(due, today, weeks);
      if (weekIdx !== null) {
        outflowsByWeek[weekIdx] = addDecimals(
          outflowsByWeek[weekIdx] ?? "0.0000",
          outstanding,
        );
      }
    }

    for (const tmpl of recurringBillTemplates) {
      const tmplTotal = Number(
        (tmpl.payload as Record<string, unknown>).total ?? 0,
      );
      const tmplTotalStr = String(tmplTotal);
      const occurrences = getOccurrencesInWindow(
        tmpl.nextRunDate,
        tmpl.endDate,
        tmpl.frequency,
        windowEnd,
      );
      for (const occ of occurrences) {
        const weekIdx = this.findWeekIndex(occ, today, weeks);
        if (weekIdx !== null) {
          outflowsByWeek[weekIdx] = addDecimals(
            outflowsByWeek[weekIdx] ?? "0.0000",
            tmplTotalStr,
          );
        }
      }
    }

    for (let i = 0; i < weeks; i++) {
      if ((i + 1) % 4 === 0) {
        outflowsByWeek[i] = addDecimals(
          outflowsByWeek[i] ?? "0.0000",
          weeklyPayrollEstimate,
        );
      }
    }

    for (const spend of assumptions.plannedSpend) {
      const amountStr = String(spend.amount);
      if (spend.recurringWeekly) {
        for (let i = spend.startWeek; i < weeks; i++) {
          outflowsByWeek[i] = addDecimals(
            outflowsByWeek[i] ?? "0.0000",
            amountStr,
          );
        }
      } else if (spend.startWeek < weeks) {
        outflowsByWeek[spend.startWeek] = addDecimals(
          outflowsByWeek[spend.startWeek] ?? "0.0000",
          amountStr,
        );
      }
    }

    const forecastWeeks: ForecastWeek[] = [];
    let runningCash = openingCash;
    let totalInflows = "0.0000";
    let totalOutflows = "0.0000";

    for (let i = 0; i < weeks; i++) {
      const { weekStart, weekEnd } = weekRange(today, i);
      const inflows = inflowsByWeek[i] ?? "0.0000";
      const outflows = outflowsByWeek[i] ?? "0.0000";
      const net = subtractDecimals(inflows, outflows);
      const closingCash = addDecimals(runningCash, net);
      forecastWeeks.push({
        weekIndex: i,
        weekStart,
        weekEnd,
        openingCash: runningCash,
        inflows,
        outflows,
        net,
        closingCash,
        minimumBalanceWarning: compareDecimals(closingCash, "0") < 0,
      });
      runningCash = closingCash;
      totalInflows = addDecimals(totalInflows, inflows);
      totalOutflows = addDecimals(totalOutflows, outflows);
    }

    return {
      scenarioId: resolvedScenarioId,
      generatedAt: new Date().toISOString(),
      weeks: forecastWeeks,
      totalInflows,
      totalOutflows,
    };
  }

  private findWeekIndex(
    date: Date,
    windowStart: Date,
    totalWeeks: number,
  ): number | null {
    for (let i = 0; i < totalWeeks; i++) {
      const { dueDateStart, dueDateEnd } = weekRange(windowStart, i);
      if (date >= dueDateStart && date <= dueDateEnd) return i;
    }
    return null;
  }

  private async resolveAssumptions(
    orgId: string,
    scenarioId: number | undefined,
  ): Promise<ScenarioAssumptions> {
    if (scenarioId !== undefined) {
      const rows = await this.db
        .select({ assumptions: finCashFlowScenarios.assumptions })
        .from(finCashFlowScenarios)
        .where(
          and(
            eq(finCashFlowScenarios.id, scenarioId),
            eq(finCashFlowScenarios.orgId, orgId),
          ),
        )
        .limit(1);
      if (rows.length > 0) {
        return parseAssumptions(rows[0]?.assumptions);
      }
      return { ...DEFAULT_ASSUMPTIONS };
    }

    const defaultRows = await this.db
      .select({ assumptions: finCashFlowScenarios.assumptions })
      .from(finCashFlowScenarios)
      .where(
        and(
          eq(finCashFlowScenarios.orgId, orgId),
          eq(finCashFlowScenarios.isDefault, true),
        ),
      )
      .limit(1);

    if (defaultRows.length > 0) {
      return parseAssumptions(defaultRows[0]?.assumptions);
    }
    return { ...DEFAULT_ASSUMPTIONS };
  }

  private async resolveScenarioId(
    orgId: string,
    scenarioId: number | undefined,
  ): Promise<number | null> {
    if (scenarioId !== undefined) {
      const rows = await this.db
        .select({ id: finCashFlowScenarios.id })
        .from(finCashFlowScenarios)
        .where(
          and(
            eq(finCashFlowScenarios.id, scenarioId),
            eq(finCashFlowScenarios.orgId, orgId),
          ),
        )
        .limit(1);
      return rows[0]?.id ?? null;
    }

    const defaultRows = await this.db
      .select({ id: finCashFlowScenarios.id })
      .from(finCashFlowScenarios)
      .where(
        and(
          eq(finCashFlowScenarios.orgId, orgId),
          eq(finCashFlowScenarios.isDefault, true),
        ),
      )
      .limit(1);
    return defaultRows[0]?.id ?? null;
  }

  private async getOpeningCash(orgId: string): Promise<string> {
    const rows = await this.db
      .select({ balance: finBankAccounts.currentBalance })
      .from(finBankAccounts)
      .where(
        and(
          eq(finBankAccounts.orgId, orgId),
          eq(finBankAccounts.isActive, true),
        ),
      );
    return rows.reduce(
      (acc, r) => addDecimals(acc, r.balance ?? "0"),
      "0.0000",
    );
  }

  private async getOpenInvoices(
    orgId: string,
  ): Promise<
    Array<{ total: string; amountPaid: string; dueDate: string | null }>
  > {
    return this.db
      .select({
        total: invoices.total,
        amountPaid: invoices.amountPaid,
        dueDate: invoices.dueDate,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.orgId, orgId),
          inArray(invoices.status, ["SENT", "OVERDUE", "PARTIAL"]),
        ),
      );
  }

  private async getRecurringInvoiceTemplates(
    orgId: string,
    today: Date,
  ): Promise<
    Array<{
      nextRunDate: string | null;
      endDate: string | null;
      frequency: string;
      payload: unknown;
    }>
  > {
    const todayStr = isoDateStr(today);
    return this.db
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
          or(
            isNull(finRecurringInvoiceTemplates.endDate),
            sql`${finRecurringInvoiceTemplates.endDate} >= ${todayStr}`,
          ),
        ),
      );
  }

  private async getOpenBills(
    orgId: string,
  ): Promise<
    Array<{ total: string; amountPaid: string; dueDate: string | null }>
  > {
    return this.db
      .select({
        total: purchaseBills.total,
        amountPaid: purchaseBills.amountPaid,
        dueDate: purchaseBills.dueDate,
      })
      .from(purchaseBills)
      .where(
        and(
          eq(purchaseBills.orgId, orgId),
          inArray(purchaseBills.status, ["APPROVED", "PARTIAL"]),
        ),
      );
  }

  private async getRecurringBillTemplates(
    orgId: string,
    today: Date,
  ): Promise<
    Array<{
      nextRunDate: string | null;
      endDate: string | null;
      frequency: string;
      payload: unknown;
    }>
  > {
    const todayStr = isoDateStr(today);
    return this.db
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
          or(
            isNull(finRecurringBillTemplates.endDate),
            sql`${finRecurringBillTemplates.endDate} >= ${todayStr}`,
          ),
        ),
      );
  }

  private async getMonthlyPayrollEstimate(orgId: string): Promise<string> {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const payrollAccountRows = await this.db
      .select({ accountId: accSystemAccountMap.accountId })
      .from(accSystemAccountMap)
      .where(
        and(
          eq(accSystemAccountMap.orgId, orgId),
          eq(accSystemAccountMap.purpose, "PAYROLL_PAYABLE"),
        ),
      );

    if (payrollAccountRows.length === 0) return "0.0000";

    const accountIds = payrollAccountRows.map((r) => r.accountId);
    const rows = await this.db
      .select({ total: sql<string>`SUM(${journalLines.credit})` })
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
    const monthly = Number(totalCredit) / 3;
    return String(monthly);
  }

  async compareForecast(
    orgId: string,
    query: CompareScenariosQuery,
    requesterId: string,
  ): Promise<ScenarioCompareResponse> {
    const { scenarioIds } = query;

    const scenarioRows = await this.db
      .select({
        id: finCashFlowScenarios.id,
        name: finCashFlowScenarios.name,
        kind: finCashFlowScenarios.kind,
      })
      .from(finCashFlowScenarios)
      .where(
        and(
          eq(finCashFlowScenarios.orgId, orgId),
          inArray(finCashFlowScenarios.id, scenarioIds),
        ),
      );

    const forecasts = await Promise.all(
      scenarioIds.map((sid) =>
        this.getForecast(orgId, { weeks: 13, scenarioId: sid }, requesterId),
      ),
    );

    const weekCount = forecasts[0]?.weeks.length ?? 13;
    const comparedWeeks = Array.from({ length: weekCount }, (_, i) => {
      const first = forecasts[0]?.weeks[i];
      const closingCash: Record<number, string> = {};
      for (let j = 0; j < scenarioIds.length; j++) {
        const sid = scenarioIds[j];
        const week = forecasts[j]?.weeks[i];
        if (sid !== undefined && week !== undefined) {
          closingCash[sid] = week.closingCash;
        }
      }
      return {
        weekIndex: i,
        weekStart: first?.weekStart ?? "",
        closingCash,
      };
    });

    return {
      scenarioIds,
      scenarios: scenarioRows.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
      })),
      weeks: comparedWeeks,
    };
  }
}
