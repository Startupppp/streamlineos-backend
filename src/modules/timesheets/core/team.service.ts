import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, timesheetPeriods } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { applyScope } from "../../access/apply-scope";
import { resolveReportsScope } from "./timesheets-core-scope";
import type { TeamWeekSummaryQuery } from "./dto/team.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class TeamService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getWeekSummary(u: CurrentUserContext, query: TeamWeekSummaryQuery) {
    const ids = query.userIds.slice(0, 100);
    if (ids.length === 0) return { summaries: [] };

    const scope = await resolveReportsScope(this.access, u);

    const [periods, dailyRows] = await Promise.all([
      this.db
        .select({
          id: timesheetPeriods.id,
          orgId: timesheetPeriods.orgId,
          userId: timesheetPeriods.userId,
          periodStart: timesheetPeriods.periodStart,
          periodEnd: timesheetPeriods.periodEnd,
          status: timesheetPeriods.status,
          totalHours: timesheetPeriods.totalHours,
          billableHours: timesheetPeriods.billableHours,
          nonBillableHours: timesheetPeriods.nonBillableHours,
          submittedAt: timesheetPeriods.submittedAt,
          approvedAt: timesheetPeriods.approvedAt,
          rejectedAt: timesheetPeriods.rejectedAt,
          lockedAt: timesheetPeriods.lockedAt,
          currentApproverId: timesheetPeriods.currentApproverId,
          rejectionReason: timesheetPeriods.rejectionReason,
          createdAt: timesheetPeriods.createdAt,
          updatedAt: timesheetPeriods.updatedAt,
        })
        .from(timesheetPeriods)
        .where(
          and(
            eq(timesheetPeriods.orgId, u.orgId),
            inArray(timesheetPeriods.userId, ids),
            lte(timesheetPeriods.periodStart, query.endDate),
            gte(timesheetPeriods.periodEnd, query.startDate),
            applyScope(scope, u.orgId, u.userId, { ownerColumn: timesheetPeriods.userId }),
          ),
        ),
      this.db
        .select({
          userId: timesheets.userId,
          date: timesheets.date,
          hours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        })
        .from(timesheets)
        .where(
          and(
            eq(timesheets.orgId, u.orgId),
            inArray(timesheets.userId, ids),
            isNull(timesheets.voidedAt),
            gte(timesheets.date, query.startDate),
            lte(timesheets.date, query.endDate),
            applyScope(scope, u.orgId, u.userId, { ownerColumn: timesheets.userId }),
          ),
        )
        .groupBy(timesheets.userId, timesheets.date),
    ]);

    const periodByUser = new Map(periods.map((p) => [p.userId, p]));
    const dailyByUser = new Map<string, Record<string, number>>();
    const totalByUser = new Map<string, number>();
    for (const row of dailyRows) {
      const hours = round2(parseFloat(row.hours));
      const map = dailyByUser.get(row.userId) ?? {};
      map[row.date] = hours;
      dailyByUser.set(row.userId, map);
      totalByUser.set(row.userId, round2((totalByUser.get(row.userId) ?? 0) + hours));
    }

    const summaries = ids.map((userId) => ({
      userId,
      period: periodByUser.get(userId) ?? null,
      dailyHours: dailyByUser.get(userId) ?? {},
      totalHours: totalByUser.get(userId) ?? 0,
    }));

    return { summaries };
  }
}
