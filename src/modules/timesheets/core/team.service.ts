import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, timesheetPeriods, organizationMembers } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveReportsScope, applyMembershipScope } from "./timesheets-core-scope";
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
    const actorMembId = actingMembershipId(u.principal);

    const memberRows = await this.db
      .select({ id: organizationMembers.id, userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, u.orgId), inArray(organizationMembers.userId, ids)))
      .limit(ids.length);

    const userIdToMembId = new Map(memberRows.map((m) => [m.userId, m.id]));
    const membIdToUserId = new Map(memberRows.map((m) => [m.id, m.userId]));
    const membershipIds = memberRows.map((m) => m.id);

    if (membershipIds.length === 0) {
      return { summaries: ids.map((userId) => ({ userId, period: null, dailyHours: {}, totalHours: 0 })) };
    }

    const [periods, dailyRows] = await Promise.all([
      this.db
        .select({
          id: timesheetPeriods.id,
          orgId: timesheetPeriods.orgId,
          userMembershipId: timesheetPeriods.userMembershipId,
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
          currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
          rejectionReason: timesheetPeriods.rejectionReason,
          createdAt: timesheetPeriods.createdAt,
          updatedAt: timesheetPeriods.updatedAt,
        })
        .from(timesheetPeriods)
        .where(
          and(
            eq(timesheetPeriods.orgId, u.orgId),
            inArray(timesheetPeriods.userMembershipId, membershipIds),
            lte(timesheetPeriods.periodStart, query.endDate),
            gte(timesheetPeriods.periodEnd, query.startDate),
            applyMembershipScope(scope, actorMembId, timesheetPeriods.userMembershipId),
          ),
        ),
      this.db
        .select({
          userMembershipId: timesheets.userMembershipId,
          date: timesheets.date,
          hours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        })
        .from(timesheets)
        .where(
          and(
            eq(timesheets.orgId, u.orgId),
            inArray(timesheets.userMembershipId, membershipIds),
            isNull(timesheets.voidedAt),
            gte(timesheets.date, query.startDate),
            lte(timesheets.date, query.endDate),
            applyMembershipScope(scope, actorMembId, timesheets.userMembershipId),
          ),
        )
        .groupBy(timesheets.userMembershipId, timesheets.date),
    ]);

    const periodByMembId = new Map(periods.map((p) => [p.userMembershipId, p]));
    const dailyByMembId = new Map<number, Record<string, number>>();
    const totalByMembId = new Map<number, number>();
    for (const row of dailyRows) {
      const membId = row.userMembershipId;
      if (membId === null) continue;
      const hours = round2(parseFloat(row.hours));
      const map = dailyByMembId.get(membId) ?? {};
      map[row.date] = hours;
      dailyByMembId.set(membId, map);
      totalByMembId.set(membId, round2((totalByMembId.get(membId) ?? 0) + hours));
    }

    const summaries = ids.map((userId) => {
      const membId = userIdToMembId.get(userId);
      return {
        userId,
        period: membId != null ? periodByMembId.get(membId) ?? null : null,
        dailyHours: membId != null ? dailyByMembId.get(membId) ?? {} : {},
        totalHours: membId != null ? totalByMembId.get(membId) ?? 0 : 0,
      };
    });

    return { summaries };
  }
}
