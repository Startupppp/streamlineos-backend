import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheets, timesheetPeriods, timesheetSettings, projects, users } from "../../db/schema";
import { AccessService } from "../access/access.service";
import { applyScope } from "../access/apply-scope";
import { resolveReportsScope } from "./timesheets-core-scope";
import type { OverviewQuery, ReportRangeQuery } from "./dto/reports.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  averageHours,
  currencyBreakdown,
  daysBetween,
  expectedHoursForRange,
  hoursBetween,
  missingWeekdayCount,
  resolveDateRange,
  round1,
  round2,
  utilizationRate,
  writeOffRate,
  type CurrencyAmountInput,
} from "./lib/report-metrics";

function round2Local(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getOverview(u: CurrentUserContext, query: OverviewQuery) {
    const scope = await resolveReportsScope(this.access, u);

    const conditions = [
      eq(timesheets.orgId, u.orgId),
      isNull(timesheets.voidedAt),
      applyScope(scope, u.userId, { ownerColumn: timesheets.userId }),
    ];

    if (query.userId && (scope === "all" || u.isPlatformAdmin || u.isOrgOwner)) {
      conditions.push(eq(timesheets.userId, query.userId));
    }
    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));

    const periodConditions = [
      eq(timesheetPeriods.orgId, u.orgId),
      eq(timesheetPeriods.status, "SUBMITTED"),
      applyScope(scope, u.userId, { ownerColumn: timesheetPeriods.userId }),
    ];
    if (query.startDate) periodConditions.push(gte(timesheetPeriods.periodStart, query.startDate));
    if (query.endDate) periodConditions.push(lte(timesheetPeriods.periodEnd, query.endDate));

    const byProjectQuery = this.db
      .select({
        projectId: timesheets.projectId,
        hours: sql<string>`SUM(${timesheets.hours}::numeric)::text`,
      })
      .from(timesheets)
      .where(and(...conditions, sql`${timesheets.projectId} IS NOT NULL`))
      .groupBy(timesheets.projectId);

    const [aggResult, byDayRows, byProjectRows, pendingResult] = await Promise.all([
      this.db
        .select({
          totalHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
          billableHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.isBillable} THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
          nonBillableHours: sql<string>`COALESCE(SUM(CASE WHEN NOT ${timesheets.isBillable} THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
          approvedHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.status} = 'APPROVED' THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
          pendingApprovalHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.status} = 'PENDING' THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
          activeUsers: sql<number>`COUNT(DISTINCT ${timesheets.userId})::int`,
        })
        .from(timesheets)
        .where(and(...conditions)),
      this.db
        .select({
          date: timesheets.date,
          hours: sql<string>`SUM(${timesheets.hours}::numeric)::text`,
        })
        .from(timesheets)
        .where(and(...conditions))
        .groupBy(timesheets.date)
        .orderBy(timesheets.date),
      byProjectQuery,
      this.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(timesheetPeriods)
        .where(and(...periodConditions)),
    ]);

    const agg = aggResult[0];
    const totalHours = round2Local(Number(agg?.totalHours ?? 0));
    const billableHours = round2Local(Number(agg?.billableHours ?? 0));

    const projectIds = byProjectRows
      .map((r) => r.projectId)
      .filter((id): id is number => id !== null);

    const projRows = projectIds.length > 0
      ? await this.db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : [];
    const projectNames = new Map(projRows.map((p) => [p.id, p.name]));

    return {
      totalHours,
      billableHours,
      nonBillableHours: round2Local(Number(agg?.nonBillableHours ?? 0)),
      billableRatio: totalHours > 0 ? round2Local(billableHours / totalHours) : 0,
      approvedHours: round2Local(Number(agg?.approvedHours ?? 0)),
      pendingApprovalHours: round2Local(Number(agg?.pendingApprovalHours ?? 0)),
      pendingPeriods: Number(pendingResult[0]?.count ?? 0),
      activeUsers: Number(agg?.activeUsers ?? 0),
      byDay: byDayRows.map((r) => ({ date: r.date, hours: round2Local(Number(r.hours)) })),
      byProject: byProjectRows
        .filter((r) => r.projectId !== null)
        .map((r) => ({
          projectId: r.projectId as number,
          projectName: projectNames.get(r.projectId as number) ?? "Unknown",
          hours: round2Local(Number(r.hours)),
        })),
    };
  }

  /**
   * Utilization report, per user plus an org-wide summary.
   * Metric definitions:
   * - totalHours: sum of non-voided entry hours in the date range.
   * - billableHours / nonBillableHours: totalHours split by the entry's isBillable flag.
   * - billableUtilization: billableHours / totalHours (0 when totalHours is 0), 3 decimals.
   * Users are ordered by totalHours descending; summary applies the same math to the scoped total.
   */
  async getUtilization(u: CurrentUserContext, query: ReportRangeQuery) {
    const scope = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = resolveDateRange(query.startDate, query.endDate);

    const conditions = [
      eq(timesheets.orgId, u.orgId),
      isNull(timesheets.voidedAt),
      applyScope(scope, u.userId, { ownerColumn: timesheets.userId }),
      gte(timesheets.date, startDate),
      lte(timesheets.date, endDate),
    ];

    const rows = await this.db
      .select({
        userId: timesheets.userId,
        name: users.name,
        email: users.email,
        totalHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        billableHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.isBillable} THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
        nonBillableHours: sql<string>`COALESCE(SUM(CASE WHEN NOT ${timesheets.isBillable} THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
      })
      .from(timesheets)
      .leftJoin(users, eq(timesheets.userId, users.id))
      .where(and(...conditions))
      .groupBy(timesheets.userId, users.name, users.email)
      .orderBy(sql`SUM(${timesheets.hours}::numeric) DESC`);

    const perUser = rows.map((r) => {
      const totalHours = round2(Number(r.totalHours));
      const billableHours = round2(Number(r.billableHours));
      return {
        userId: r.userId,
        name: r.name,
        email: r.email,
        totalHours,
        billableHours,
        nonBillableHours: round2(Number(r.nonBillableHours)),
        billableUtilization: utilizationRate(billableHours, totalHours),
      };
    });

    const summaryTotal = round2(perUser.reduce((a, r) => a + r.totalHours, 0));
    const summaryBillable = round2(perUser.reduce((a, r) => a + r.billableHours, 0));

    return {
      startDate,
      endDate,
      summary: {
        totalHours: summaryTotal,
        billableHours: summaryBillable,
        nonBillableHours: round2(perUser.reduce((a, r) => a + r.nonBillableHours, 0)),
        billableUtilization: utilizationRate(summaryBillable, summaryTotal),
        activeUsers: perUser.length,
      },
      users: perUser,
    };
  }

  /**
   * Client profitability over APPROVED, billable, non-voided entries in the range.
   * Entries are attributed to a client via project.clientId (projects.clientId references
   * users.id in this schema); entries without a project or client fall under clientId null
   * as "No client".
   * Metric definitions (per client):
   * - hours: approved billable hours.
   * - missingRateHours: hours whose entry billRate is null; these contribute no amount
   *   (amounts are never fabricated for unrated entries).
   * - amounts: per-currency array (entry currency, defaulting to USD when unset) with
   *   - billableAmount: SUM(hours * billRate) over rows with a billRate, 2 decimals.
   *   - costAmount: SUM(hours * costRate) over rows with a costRate; null when no
   *     cost-rate rows exist for that currency (cost unknown).
   *   - margin: billableAmount - costAmount; null when costAmount is null.
   * Clients are ordered by hours descending.
   */
  async getClientProfitability(u: CurrentUserContext, query: ReportRangeQuery) {
    const scope = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = resolveDateRange(query.startDate, query.endDate);

    const conditions = [
      eq(timesheets.orgId, u.orgId),
      isNull(timesheets.voidedAt),
      eq(timesheets.status, "APPROVED"),
      eq(timesheets.isBillable, true),
      applyScope(scope, u.userId, { ownerColumn: timesheets.userId }),
      gte(timesheets.date, startDate),
      lte(timesheets.date, endDate),
    ];

    const currencyExpr = sql<string>`COALESCE(${timesheets.currency}, 'USD')`;

    const rows = await this.db
      .select({
        clientId: projects.clientId,
        currency: currencyExpr,
        hours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        billableAmount: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.billRate} IS NOT NULL THEN ${timesheets.hours}::numeric * ${timesheets.billRate}::numeric END), 0)::text`,
        costAmount: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.costRate} IS NOT NULL THEN ${timesheets.hours}::numeric * ${timesheets.costRate}::numeric END), 0)::text`,
        costRateRows: sql<number>`COUNT(*) FILTER (WHERE ${timesheets.costRate} IS NOT NULL)::int`,
        missingRateHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.billRate} IS NULL THEN ${timesheets.hours}::numeric END), 0)::text`,
      })
      .from(timesheets)
      .leftJoin(projects, eq(timesheets.projectId, projects.id))
      .where(and(...conditions))
      .groupBy(projects.clientId, currencyExpr);

    const clientIds = [...new Set(rows.map((r) => r.clientId).filter((id): id is string => id !== null))];
    let clientNames = new Map<string, string>();
    if (clientIds.length > 0) {
      const nameRows = await this.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, clientIds));
      clientNames = new Map(nameRows.map((r) => [r.id, r.name ?? r.email]));
    }

    const byClient = new Map<
      string | null,
      { hours: number; missingRateHours: number; amountRows: CurrencyAmountInput[] }
    >();
    for (const r of rows) {
      const acc = byClient.get(r.clientId) ?? { hours: 0, missingRateHours: 0, amountRows: [] };
      acc.hours += Number(r.hours);
      acc.missingRateHours += Number(r.missingRateHours);
      acc.amountRows.push({
        currency: r.currency,
        billableAmount: Number(r.billableAmount),
        costAmount: Number(r.costRateRows) > 0 ? Number(r.costAmount) : null,
      });
      byClient.set(r.clientId, acc);
    }

    const clients = [...byClient.entries()]
      .map(([clientId, acc]) => ({
        clientId,
        clientName: clientId === null ? "No client" : clientNames.get(clientId) ?? "Unknown client",
        hours: round2(acc.hours),
        missingRateHours: round2(acc.missingRateHours),
        amounts: currencyBreakdown(acc.amountRows),
      }))
      .sort((a, b) => b.hours - a.hours);

    return { startDate, endDate, clients };
  }

  /**
   * Compliance report per user for the range.
   * Metric definitions:
   * - expectedHours: completeWeeksInRange(startDate, endDate) * settings.expectedWeeklyHours;
   *   null when expectedWeeklyHours is not configured. Same value for every user.
   * - actualHours: sum of the user's non-voided entry hours in the range.
   * - missingDays: count of Mon-Fri dates in the range with zero non-voided entries for the user.
   * - periodsSubmitted: periods overlapping the range with submittedAt set.
   * - periodsApproved: overlapping periods with status APPROVED.
   * - periodsOverdue: overlapping periods ending more than 3 days ago still OPEN or DRAFT.
   * Users are included when they have entries or periods in the range, ordered by actualHours desc.
   */
  async getCompliance(u: CurrentUserContext, query: ReportRangeQuery) {
    const scope = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = resolveDateRange(query.startDate, query.endDate);

    const entryConditions = [
      eq(timesheets.orgId, u.orgId),
      isNull(timesheets.voidedAt),
      applyScope(scope, u.userId, { ownerColumn: timesheets.userId }),
      gte(timesheets.date, startDate),
      lte(timesheets.date, endDate),
    ];

    const periodConditions = [
      eq(timesheetPeriods.orgId, u.orgId),
      applyScope(scope, u.userId, { ownerColumn: timesheetPeriods.userId }),
      lte(timesheetPeriods.periodStart, endDate),
      gte(timesheetPeriods.periodEnd, startDate),
    ];

    const [hoursRows, dateRows, periodRows, settingsRows] = await Promise.all([
      this.db
        .select({
          userId: timesheets.userId,
          actualHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        })
        .from(timesheets)
        .where(and(...entryConditions))
        .groupBy(timesheets.userId),
      this.db
        .select({ userId: timesheets.userId, date: timesheets.date })
        .from(timesheets)
        .where(and(...entryConditions))
        .groupBy(timesheets.userId, timesheets.date),
      this.db
        .select({
          userId: timesheetPeriods.userId,
          periodsSubmitted: sql<number>`COUNT(*) FILTER (WHERE ${timesheetPeriods.submittedAt} IS NOT NULL)::int`,
          periodsApproved: sql<number>`COUNT(*) FILTER (WHERE ${timesheetPeriods.status} = 'APPROVED')::int`,
          periodsOverdue: sql<number>`COUNT(*) FILTER (WHERE ${timesheetPeriods.status} IN ('OPEN', 'DRAFT') AND ${timesheetPeriods.periodEnd} < CURRENT_DATE - INTERVAL '3 days')::int`,
        })
        .from(timesheetPeriods)
        .where(and(...periodConditions))
        .groupBy(timesheetPeriods.userId),
      this.db
        .select({ expectedWeeklyHours: timesheetSettings.expectedWeeklyHours })
        .from(timesheetSettings)
        .where(eq(timesheetSettings.orgId, u.orgId))
        .limit(1),
    ]);

    const expectedWeeklyHours =
      settingsRows[0]?.expectedWeeklyHours != null ? Number(settingsRows[0].expectedWeeklyHours) : null;
    const expectedHours = expectedHoursForRange(startDate, endDate, expectedWeeklyHours);

    const workedDates = new Map<string, Set<string>>();
    for (const r of dateRows) {
      const set = workedDates.get(r.userId) ?? new Set<string>();
      set.add(r.date);
      workedDates.set(r.userId, set);
    }

    const hoursByUser = new Map(hoursRows.map((r) => [r.userId, Number(r.actualHours)]));
    const periodsByUser = new Map(periodRows.map((r) => [r.userId, r]));
    const userIds = [...new Set([...hoursByUser.keys(), ...periodsByUser.keys()])];

    let userInfo = new Map<string, { name: string | null; email: string }>();
    if (userIds.length > 0) {
      const nameRows = await this.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, userIds));
      userInfo = new Map(nameRows.map((r) => [r.id, { name: r.name, email: r.email }]));
    }

    const perUser = userIds
      .map((userId) => {
        const periods = periodsByUser.get(userId);
        return {
          userId,
          name: userInfo.get(userId)?.name ?? null,
          email: userInfo.get(userId)?.email ?? null,
          expectedHours,
          actualHours: round2(hoursByUser.get(userId) ?? 0),
          missingDays: missingWeekdayCount(startDate, endDate, workedDates.get(userId) ?? new Set()),
          periodsSubmitted: Number(periods?.periodsSubmitted ?? 0),
          periodsApproved: Number(periods?.periodsApproved ?? 0),
          periodsOverdue: Number(periods?.periodsOverdue ?? 0),
        };
      })
      .sort((a, b) => b.actualHours - a.actualHours);

    return { startDate, endDate, expectedWeeklyHours, users: perUser };
  }

  /**
   * Approval SLA over periods submitted in the range (submittedAt within [startDate, endDate]).
   * Metric definitions:
   * - byStatus: count of submitted periods per current status.
   * - avgHoursToDecision: mean hours from submittedAt to approvedAt/rejectedAt over decided
   *   periods, 1 decimal; null when nothing has been decided.
   * - oldestPending: the SUBMITTED period waiting longest, with daysWaiting = days since
   *   submittedAt (1 decimal); null when nothing is pending.
   * - perApprover: keyed by currentApproverId (falls back to approvedBy for decided rows):
   *   pendingCount = periods still SUBMITTED, avgDecisionHours = mean decision time (1 decimal,
   *   null when that approver has no decisions). Ordered by pendingCount desc.
   */
  async getApprovalSla(u: CurrentUserContext, query: ReportRangeQuery) {
    const scope = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = resolveDateRange(query.startDate, query.endDate);

    const rows = await this.db
      .select({
        id: timesheetPeriods.id,
        userId: timesheetPeriods.userId,
        status: timesheetPeriods.status,
        submittedAt: timesheetPeriods.submittedAt,
        approvedAt: timesheetPeriods.approvedAt,
        rejectedAt: timesheetPeriods.rejectedAt,
        currentApproverId: timesheetPeriods.currentApproverId,
        approvedBy: timesheetPeriods.approvedBy,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, u.orgId),
          applyScope(scope, u.userId, { ownerColumn: timesheetPeriods.userId }),
          sql`${timesheetPeriods.submittedAt} IS NOT NULL`,
          sql`${timesheetPeriods.submittedAt} >= ${startDate}::timestamp`,
          sql`${timesheetPeriods.submittedAt} < ${endDate}::date + INTERVAL '1 day'`,
        ),
      );

    const now = new Date();
    const byStatus: Record<string, number> = {};
    const decisionHours: number[] = [];
    const perApprover = new Map<string, { pendingCount: number; decisionHours: number[] }>();
    let oldestPending: { periodId: number; userId: string; submittedAt: string; daysWaiting: number } | null =
      null;

    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (!r.submittedAt) continue;

      const decidedAt = r.approvedAt ?? r.rejectedAt;
      const approverId = r.currentApproverId ?? r.approvedBy;
      const approver = approverId
        ? perApprover.get(approverId) ?? { pendingCount: 0, decisionHours: [] }
        : null;

      if (decidedAt) {
        const hrs = hoursBetween(r.submittedAt, decidedAt);
        decisionHours.push(hrs);
        approver?.decisionHours.push(hrs);
      } else if (r.status === "SUBMITTED") {
        if (approver) approver.pendingCount += 1;
        if (!oldestPending || r.submittedAt.getTime() < Date.parse(oldestPending.submittedAt)) {
          oldestPending = {
            periodId: r.id,
            userId: r.userId,
            submittedAt: r.submittedAt.toISOString(),
            daysWaiting: round1(daysBetween(r.submittedAt, now)),
          };
        }
      }
      if (approverId && approver) perApprover.set(approverId, approver);
    }

    const approverIds = [...perApprover.keys()];
    let approverInfo = new Map<string, { name: string | null; email: string }>();
    if (approverIds.length > 0) {
      const nameRows = await this.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, approverIds));
      approverInfo = new Map(nameRows.map((r) => [r.id, { name: r.name, email: r.email }]));
    }

    return {
      startDate,
      endDate,
      totalSubmitted: rows.length,
      byStatus,
      avgHoursToDecision: averageHours(decisionHours),
      oldestPending,
      perApprover: [...perApprover.entries()]
        .map(([approverId, a]) => ({
          approverId,
          name: approverInfo.get(approverId)?.name ?? null,
          email: approverInfo.get(approverId)?.email ?? null,
          pendingCount: a.pendingCount,
          avgDecisionHours: averageHours(a.decisionHours),
        }))
        .sort((a, b) => b.pendingCount - a.pendingCount),
    };
  }

  /**
   * Billing leakage over APPROVED, non-voided entries in the range (except voidedHours,
   * which intentionally measures voided entries in the same range).
   * Metric definitions:
   * - billableHours / nonBillableHours: approved hours split by isBillable.
   * - writeOffRate: nonBillableHours / (billableHours + nonBillableHours), 3 decimals,
   *   0 when there are no approved hours.
   * - approvedBillableUninvoiced: approved billable hours with invoicingStatus UNINVOICED;
   *   amounts = per-currency SUM(hours * billRate) over rows with a billRate (entry currency,
   *   defaulting to USD when unset).
   * - missingRateHours: approved billable hours whose billRate is null (unpriceable revenue).
   * - voidedHours: hours on voided entries (voidedAt set) dated within the range.
   */
  async getBillingLeakage(u: CurrentUserContext, query: ReportRangeQuery) {
    const scope = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = resolveDateRange(query.startDate, query.endDate);

    const scopeCondition = applyScope(scope, u.userId, { ownerColumn: timesheets.userId });
    const rangeConditions = [
      eq(timesheets.orgId, u.orgId),
      scopeCondition,
      gte(timesheets.date, startDate),
      lte(timesheets.date, endDate),
    ];
    const approvedConditions = [
      ...rangeConditions,
      isNull(timesheets.voidedAt),
      eq(timesheets.status, "APPROVED"),
    ];

    const currencyExpr = sql<string>`COALESCE(${timesheets.currency}, 'USD')`;

    const [aggResult, uninvoicedAmountRows, voidedResult] = await Promise.all([
      this.db
        .select({
          billableHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric) FILTER (WHERE ${timesheets.isBillable}), 0)::text`,
          nonBillableHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric) FILTER (WHERE NOT ${timesheets.isBillable}), 0)::text`,
          uninvoicedHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric) FILTER (WHERE ${timesheets.isBillable} AND ${timesheets.invoicingStatus} = 'UNINVOICED'), 0)::text`,
          missingRateHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric) FILTER (WHERE ${timesheets.isBillable} AND ${timesheets.billRate} IS NULL), 0)::text`,
        })
        .from(timesheets)
        .where(and(...approvedConditions)),
      this.db
        .select({
          currency: currencyExpr,
          amount: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric * ${timesheets.billRate}::numeric), 0)::text`,
        })
        .from(timesheets)
        .where(
          and(
            ...approvedConditions,
            eq(timesheets.isBillable, true),
            eq(timesheets.invoicingStatus, "UNINVOICED"),
            sql`${timesheets.billRate} IS NOT NULL`,
          ),
        )
        .groupBy(currencyExpr),
      this.db
        .select({
          voidedHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        })
        .from(timesheets)
        .where(and(...rangeConditions, sql`${timesheets.voidedAt} IS NOT NULL`)),
    ]);

    const agg = aggResult[0];
    const billableHours = round2(Number(agg?.billableHours ?? 0));
    const nonBillableHours = round2(Number(agg?.nonBillableHours ?? 0));

    return {
      startDate,
      endDate,
      billableHours,
      nonBillableHours,
      writeOffRate: writeOffRate(billableHours, nonBillableHours),
      approvedBillableUninvoiced: {
        hours: round2(Number(agg?.uninvoicedHours ?? 0)),
        amounts: uninvoicedAmountRows
          .map((r) => ({ currency: r.currency, amount: round2(Number(r.amount)) }))
          .sort((a, b) => a.currency.localeCompare(b.currency)),
      },
      missingRateHours: round2(Number(agg?.missingRateHours ?? 0)),
      voidedHours: round2(Number(voidedResult[0]?.voidedHours ?? 0)),
    };
  }
}
