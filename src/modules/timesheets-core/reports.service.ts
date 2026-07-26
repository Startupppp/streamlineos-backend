import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheets, timesheetPeriods, projects } from "../../db/schema";
import { AccessService } from "../access/access.service";
import { applyScope } from "../access/apply-scope";
import { resolveReportsScope } from "./timesheets-core-scope";
import type { OverviewQuery } from "./dto/reports.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function round2(n: number): number {
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
    const totalHours = round2(Number(agg?.totalHours ?? 0));
    const billableHours = round2(Number(agg?.billableHours ?? 0));

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
      nonBillableHours: round2(Number(agg?.nonBillableHours ?? 0)),
      billableRatio: totalHours > 0 ? round2(billableHours / totalHours) : 0,
      approvedHours: round2(Number(agg?.approvedHours ?? 0)),
      pendingApprovalHours: round2(Number(agg?.pendingApprovalHours ?? 0)),
      pendingPeriods: Number(pendingResult[0]?.count ?? 0),
      activeUsers: Number(agg?.activeUsers ?? 0),
      byDay: byDayRows.map((r) => ({ date: r.date, hours: round2(Number(r.hours)) })),
      byProject: byProjectRows
        .filter((r) => r.projectId !== null)
        .map((r) => ({
          projectId: r.projectId as number,
          projectName: projectNames.get(r.projectId as number) ?? "Unknown",
          hours: round2(Number(r.hours)),
        })),
    };
  }
}
