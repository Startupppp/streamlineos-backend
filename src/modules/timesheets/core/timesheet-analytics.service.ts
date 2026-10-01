import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, timesheetPeriods, timesheetSettings, projects, users, organizationMembers, holidays } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveReportsScope, membershipTeamScope } from "./timesheets-core-scope";
import type { ReportRangeQuery } from "./dto/reports.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
  writeOffRate,
  type CurrencyAmountInput,
} from "./lib/report-metrics";

function boundedReportRange(startDate?: string, endDate?: string) {
  try {
    return resolveDateRange(startDate, endDate);
  } catch (err) {
    if (err instanceof RangeError) throw new BadRequestException(err.message);
    throw err;
  }
}

@Injectable()
export class TimesheetAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getClientProfitability(u: CurrentUserContext, query: ReportRangeQuery) {
    const read = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = boundedReportRange(query.startDate, query.endDate);
    const actorMembId = actingMembershipId(u.principal);

    const where = read.compose(
      {
        tenant: timesheets.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, actorMembId, timesheets.userMembershipId),
        and: [
          isNull(timesheets.voidedAt),
          eq(timesheets.status, "APPROVED"),
          eq(timesheets.isBillable, true),
          gte(timesheets.date, startDate),
          lte(timesheets.date, endDate),
        ],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

    const currencyExpr = sql<string>`COALESCE(${timesheets.currency}, 'USD')`;

    const rows = await this.db
      .select({
        clientId: projects.clientMembershipId,
        currency: currencyExpr,
        hours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        billableAmount: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.billRate} IS NOT NULL THEN ${timesheets.hours}::numeric * ${timesheets.billRate}::numeric END), 0)::text`,
        costAmount: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.costRate} IS NOT NULL THEN ${timesheets.hours}::numeric * ${timesheets.costRate}::numeric END), 0)::text`,
        costRateRows: sql<number>`COUNT(*) FILTER (WHERE ${timesheets.costRate} IS NOT NULL)::int`,
        missingRateHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.billRate} IS NULL THEN ${timesheets.hours}::numeric END), 0)::text`,
      })
      .from(timesheets)
      .leftJoin(projects, eq(timesheets.projectId, projects.id))
      .where(where)
      .groupBy(projects.clientMembershipId, currencyExpr);

    const clientIds = [...new Set(rows.map((r) => r.clientId).filter((id): id is number => id !== null))];
    let clientNames = new Map<number, string>();
    if (clientIds.length > 0) {
      const nameRows = await this.db
        .select({ membershipId: organizationMembers.id, name: users.name, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(
          eq(organizationMembers.orgId, u.orgId),
          eq(organizationMembers.status, "ACTIVE"),
          inArray(organizationMembers.id, clientIds),
        ));
      clientNames = new Map(nameRows.map((r) => [r.membershipId, r.name ?? r.email]));
    }

    const byClient = new Map<
       number | null,
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

  async getCompliance(u: CurrentUserContext, query: ReportRangeQuery) {
    const read = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = boundedReportRange(query.startDate, query.endDate);
    const actorMembId = actingMembershipId(u.principal);

    const tsMember = alias(organizationMembers, "ts_member");
    const periodMember = alias(organizationMembers, "period_member");
    const tsMember2 = alias(organizationMembers, "ts_member2");

    const entryWhere = read.compose(
      {
        tenant: timesheets.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, actorMembId, timesheets.userMembershipId),
        and: [isNull(timesheets.voidedAt), gte(timesheets.date, startDate), lte(timesheets.date, endDate)],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

    const periodWhere = read.compose(
      {
        tenant: timesheetPeriods.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, actorMembId, timesheetPeriods.userMembershipId),
        and: [lte(timesheetPeriods.periodStart, endDate), gte(timesheetPeriods.periodEnd, startDate)],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

    const [hoursRows, dateRows, periodRows, settingsRows] = await Promise.all([
      this.db
        .select({
          userId: tsMember.userId,
          actualHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        })
        .from(timesheets)
        .innerJoin(tsMember, and(eq(timesheets.orgId, tsMember.orgId), eq(timesheets.userMembershipId, tsMember.id)))
        .where(entryWhere)
        .groupBy(tsMember.userId),
      this.db
        .select({ userId: tsMember2.userId, date: timesheets.date })
        .from(timesheets)
        .innerJoin(tsMember2, and(eq(timesheets.orgId, tsMember2.orgId), eq(timesheets.userMembershipId, tsMember2.id)))
        .where(entryWhere)
        .groupBy(tsMember2.userId, timesheets.date),
      this.db
        .select({
          userId: periodMember.userId,
          periodsSubmitted: sql<number>`COUNT(*) FILTER (WHERE ${timesheetPeriods.submittedAt} IS NOT NULL)::int`,
          periodsApproved: sql<number>`COUNT(*) FILTER (WHERE ${timesheetPeriods.status} IN ('APPROVED', 'LOCKED'))::int`,
          periodsOverdue: sql<number>`COUNT(*) FILTER (WHERE ${timesheetPeriods.status} IN ('OPEN', 'DRAFT') AND ${timesheetPeriods.periodEnd} < CURRENT_DATE - INTERVAL '3 days')::int`,
        })
        .from(timesheetPeriods)
        .innerJoin(periodMember, and(eq(timesheetPeriods.orgId, periodMember.orgId), eq(timesheetPeriods.userMembershipId, periodMember.id)))
        .where(periodWhere)
        .groupBy(periodMember.userId),
      this.db
        .select({
          expectedWeeklyHours: timesheetSettings.expectedWeeklyHours,
          expectedDailyHours: timesheetSettings.expectedDailyHours,
        })
        .from(timesheetSettings)
        .where(eq(timesheetSettings.orgId, u.orgId))
        .limit(1),
    ]);

    const expectedWeeklyHours =
      settingsRows[0]?.expectedWeeklyHours != null ? Number(settingsRows[0].expectedWeeklyHours) : null;
    const expectedDailyHours =
      settingsRows[0]?.expectedDailyHours != null ? Number(settingsRows[0].expectedDailyHours) : null;

    const holidayRows = await this.db
      .select({ date: holidays.date })
      .from(holidays)
      .where(
        and(
          eq(holidays.orgId, u.orgId),
          gte(holidays.date, startDate),
          lte(holidays.date, endDate),
        ),
      );
    const expectedHours = expectedHoursForRange(
      startDate,
      endDate,
      expectedWeeklyHours,
      holidayRows.map((h) => h.date),
      expectedDailyHours,
    );

    const workedDates = new Map<string, Set<string>>();
    for (const r of dateRows) {
      if (!r.userId) continue;
      const set = workedDates.get(r.userId) ?? new Set<string>();
      set.add(r.date);
      workedDates.set(r.userId, set);
    }

    const hasUserId = <T extends { userId: string | null }>(r: T): r is T & { userId: string } => r.userId !== null;
    const hoursByUser = new Map(hoursRows.filter(hasUserId).map((r) => [r.userId, Number(r.actualHours)]));
    const periodsByUser = new Map(periodRows.filter(hasUserId).map((r) => [r.userId, r]));
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

  async getApprovalSla(u: CurrentUserContext, query: ReportRangeQuery) {
    const read = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = boundedReportRange(query.startDate, query.endDate);
    const actorMembId = actingMembershipId(u.principal);

    const ownerMember = alias(organizationMembers, "owner_member");
    const approverMember = alias(organizationMembers, "approver_member");
    const currentApproverMember = alias(organizationMembers, "current_approver_member");

    const where = read.compose(
      {
        tenant: timesheetPeriods.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, actorMembId, timesheetPeriods.userMembershipId),
        and: [
          sql`${timesheetPeriods.submittedAt} IS NOT NULL`,
          sql`${timesheetPeriods.submittedAt} >= ${startDate}::timestamp`,
          sql`${timesheetPeriods.submittedAt} < ${endDate}::date + INTERVAL '1 day'`,
        ],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

    const rows = await this.db
      .select({
        id: timesheetPeriods.id,
        ownerUserId: ownerMember.userId,
        status: timesheetPeriods.status,
        submittedAt: timesheetPeriods.submittedAt,
        approvedAt: timesheetPeriods.approvedAt,
        rejectedAt: timesheetPeriods.rejectedAt,
        currentApproverUserId: currentApproverMember.userId,
        approvedByUserId: approverMember.userId,
      })
      .from(timesheetPeriods)
      .innerJoin(ownerMember, and(eq(timesheetPeriods.orgId, ownerMember.orgId), eq(timesheetPeriods.userMembershipId, ownerMember.id)))
      .leftJoin(currentApproverMember, and(eq(timesheetPeriods.orgId, currentApproverMember.orgId), eq(timesheetPeriods.currentApproverMembershipId, currentApproverMember.id)))
      .leftJoin(approverMember, and(eq(timesheetPeriods.orgId, approverMember.orgId), eq(timesheetPeriods.approvedByMembershipId, approverMember.id)))
      .where(where);

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
      const approverId = r.currentApproverUserId ?? r.approvedByUserId;
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
            userId: r.ownerUserId ?? "",
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

  async getBillingLeakage(u: CurrentUserContext, query: ReportRangeQuery) {
    const read = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = boundedReportRange(query.startDate, query.endDate);
    const actorMembId = actingMembershipId(u.principal);

    const rangeWhere = read.compose(
      {
        tenant: timesheets.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, actorMembId, timesheets.userMembershipId),
        and: [gte(timesheets.date, startDate), lte(timesheets.date, endDate)],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );
    const approvedWhere = and(rangeWhere, isNull(timesheets.voidedAt), eq(timesheets.status, "APPROVED"));

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
        .where(approvedWhere),
      this.db
        .select({
          currency: currencyExpr,
          amount: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric * ${timesheets.billRate}::numeric), 0)::text`,
        })
        .from(timesheets)
        .where(
          and(
            approvedWhere,
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
        .where(and(rangeWhere, sql`${timesheets.voidedAt} IS NOT NULL`)),
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
