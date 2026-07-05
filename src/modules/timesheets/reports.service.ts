import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
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

    const entries = await this.db
      .select({
        userId: timesheets.userId,
        date: timesheets.date,
        hours: timesheets.hours,
        isBillable: timesheets.isBillable,
        status: timesheets.status,
        projectId: timesheets.projectId,
      })
      .from(timesheets)
      .where(and(...conditions));

    let totalHours = 0;
    let billableHours = 0;
    let nonBillableHours = 0;
    let approvedHours = 0;
    let pendingApprovalHours = 0;
    const activeUsers = new Set<string>();
    const byDay = new Map<string, number>();
    const byProject = new Map<number, number>();

    for (const e of entries) {
      const h = parseFloat(e.hours);
      totalHours += h;
      if (e.isBillable) billableHours += h;
      else nonBillableHours += h;
      if (e.status === "APPROVED") approvedHours += h;
      if (e.status === "PENDING") pendingApprovalHours += h;
      activeUsers.add(e.userId);

      byDay.set(e.date, round2((byDay.get(e.date) ?? 0) + h));
      if (e.projectId !== null) {
        byProject.set(e.projectId, round2((byProject.get(e.projectId) ?? 0) + h));
      }
    }

    const projectIds = [...byProject.keys()];
    let projectNames = new Map<number, string>();
    if (projectIds.length > 0) {
      const projRows = await this.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.orgId, u.orgId));
      projectNames = new Map(projRows.map((p) => [p.id, p.name]));
    }

    const periodConditions = [
      eq(timesheetPeriods.orgId, u.orgId),
      eq(timesheetPeriods.status, "SUBMITTED"),
      applyScope(scope, u.userId, { ownerColumn: timesheetPeriods.userId }),
    ];
    if (query.startDate) periodConditions.push(gte(timesheetPeriods.periodStart, query.startDate));
    if (query.endDate) periodConditions.push(lte(timesheetPeriods.periodEnd, query.endDate));

    const [pendingResult] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(timesheetPeriods)
      .where(and(...periodConditions));

    return {
      totalHours: round2(totalHours),
      billableHours: round2(billableHours),
      nonBillableHours: round2(nonBillableHours),
      billableRatio: totalHours > 0 ? round2(billableHours / totalHours) : 0,
      approvedHours: round2(approvedHours),
      pendingApprovalHours: round2(pendingApprovalHours),
      pendingPeriods: Number(pendingResult?.count ?? 0),
      activeUsers: activeUsers.size,
      byDay: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, hours]) => ({ date, hours })),
      byProject: [...byProject.entries()].map(([projectId, hours]) => ({
        projectId,
        projectName: projectNames.get(projectId) ?? "Unknown",
        hours,
      })),
    };
  }
}
