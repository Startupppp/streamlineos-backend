import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, timesheetPeriods, projects, users, organizationMembers, holidays } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveReportsScope, membershipTeamScope } from "./timesheets-core-scope";
import type { OverviewQuery, ReportRangeQuery } from "./dto/reports.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveDateRange, round2, utilizationRate } from "./lib/report-metrics";

function boundedReportRange(startDate?: string, endDate?: string) {
  try {
    return resolveDateRange(startDate, endDate);
  } catch (err) {
    if (err instanceof RangeError) throw new BadRequestException(err.message);
    throw err;
  }
}

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
    const read = await resolveReportsScope(this.access, u);
    const actorMembId = actingMembershipId(u.principal);

    let requestedMembershipId: number | undefined;
    if (query.userId && (read.discriminator === "all" || u.isOrgOwner)) {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, query.userId)))
        .limit(1);
      if (qMember) requestedMembershipId = qMember.id;
    }

    const timesheetsWhere = read.compose(
      {
        tenant: timesheets.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, actorMembId, timesheets.userMembershipId),
        and: [
          isNull(timesheets.voidedAt),
          requestedMembershipId !== undefined ? eq(timesheets.userMembershipId, requestedMembershipId) : undefined,
          query.startDate ? gte(timesheets.date, query.startDate) : undefined,
          query.endDate ? lte(timesheets.date, query.endDate) : undefined,
        ],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

    const periodsWhere = read.compose(
      {
        tenant: timesheetPeriods.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, actorMembId, timesheetPeriods.userMembershipId),
        and: [
          eq(timesheetPeriods.status, "SUBMITTED"),
          query.startDate ? gte(timesheetPeriods.periodStart, query.startDate) : undefined,
          query.endDate ? lte(timesheetPeriods.periodEnd, query.endDate) : undefined,
        ],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

    const byProjectQuery = this.db
      .select({
        projectId: timesheets.projectId,
        hours: sql<string>`SUM(${timesheets.hours}::numeric)::text`,
      })
      .from(timesheets)
      .where(and(timesheetsWhere, sql`${timesheets.projectId} IS NOT NULL`))
      .groupBy(timesheets.projectId);

    const [aggResult, byDayRows, byProjectRows, pendingResult] = await Promise.all([
      this.db
        .select({
          totalHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
          billableHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.isBillable} THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
          nonBillableHours: sql<string>`COALESCE(SUM(CASE WHEN NOT ${timesheets.isBillable} THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
          approvedHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.status} = 'APPROVED' THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
          pendingApprovalHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.status} = 'PENDING' THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
          activeUsers: sql<number>`COUNT(DISTINCT ${timesheets.userMembershipId})::int`,
        })
        .from(timesheets)
        .where(timesheetsWhere),
      this.db
        .select({
          date: timesheets.date,
          hours: sql<string>`SUM(${timesheets.hours}::numeric)::text`,
        })
        .from(timesheets)
        .where(timesheetsWhere)
        .groupBy(timesheets.date)
        .orderBy(timesheets.date),
      byProjectQuery,
      this.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(timesheetPeriods)
        .where(periodsWhere),
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
          .where(and(inArray(projects.id, projectIds), isNull(projects.deletedAt)))
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
        .filter((r): r is typeof r & { projectId: number } => r.projectId !== null)
        .map((r) => ({
          projectId: r.projectId,
          projectName: projectNames.get(r.projectId) ?? "Unknown",
          hours: round2Local(Number(r.hours)),
        })),
    };
  }

  async getUtilization(u: CurrentUserContext, query: ReportRangeQuery) {
    const read = await resolveReportsScope(this.access, u);
    const { startDate, endDate } = boundedReportRange(query.startDate, query.endDate);
    const actorMembId = actingMembershipId(u.principal);

    const ownerMember = alias(organizationMembers, "owner_member");

    const where = read.compose(
      {
        tenant: timesheets.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, actorMembId, timesheets.userMembershipId),
        and: [isNull(timesheets.voidedAt), gte(timesheets.date, startDate), lte(timesheets.date, endDate)],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

    const rows = await this.db
      .select({
        userId: ownerMember.userId,
        name: users.name,
        email: users.email,
        totalHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        billableHours: sql<string>`COALESCE(SUM(CASE WHEN ${timesheets.isBillable} THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
        nonBillableHours: sql<string>`COALESCE(SUM(CASE WHEN NOT ${timesheets.isBillable} THEN ${timesheets.hours}::numeric ELSE 0 END), 0)::text`,
      })
      .from(timesheets)
      .leftJoin(ownerMember, and(eq(timesheets.orgId, ownerMember.orgId), eq(timesheets.userMembershipId, ownerMember.id)))
      .leftJoin(users, eq(ownerMember.userId, users.id))
      .where(where)
      .groupBy(ownerMember.userId, users.name, users.email)
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

  async getHolidays(u: CurrentUserContext, startDate: string, endDate: string) {
    const rows = await this.db
      .select({ date: holidays.date, name: holidays.name, isPublic: holidays.isPublic })
      .from(holidays)
      .where(
        and(
          eq(holidays.orgId, u.orgId),
          gte(holidays.date, startDate),
          lte(holidays.date, endDate),
        ),
      )
      .orderBy(holidays.date);

    return { startDate, endDate, holidays: rows };
  }
}
