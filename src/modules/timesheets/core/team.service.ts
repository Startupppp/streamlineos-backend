import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, timesheetPeriods, organizationMembers, users } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveTeamScope, membershipScope } from "./timesheets-core-scope";
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
    const read = await resolveTeamScope(this.access, u);
    const actorMembId = actingMembershipId(u.principal);
    const requested = (query.userIds ?? []).slice(0, 100);

    const memberWhere = read.compose(
      {
        tenant: organizationMembers.orgId,
        scope: membershipScope(actorMembId, organizationMembers.id),
        and: requested.length > 0 ? [inArray(organizationMembers.userId, requested)] : [],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

    const memberRows = await this.db
      .select({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
        name: users.name,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(memberWhere)
      .limit(100);

    const ids = memberRows.map((m) => m.userId);
    if (ids.length === 0) return { summaries: [] };

    const userIdToMembId = new Map(memberRows.map((m) => [m.userId, m.id]));
    const membershipIds = memberRows.map((m) => m.id);
    const identityByUserId = new Map(memberRows.map((m) => [m.userId, { name: m.name, email: m.email }]));

    if (membershipIds.length === 0) {
      return {
        summaries: ids.map((userId) => {
          const identity = identityByUserId.get(userId);
          return {
            userId,
            name: identity?.name ?? null,
            email: identity?.email ?? null,
            period: null,
            dailyHours: {},
            totalHours: 0,
          };
        }),
      };
    }

    const periodsWhere = read.compose(
      {
        tenant: timesheetPeriods.orgId,
        scope: membershipScope(actorMembId, timesheetPeriods.userMembershipId),
        and: [
          inArray(timesheetPeriods.userMembershipId, membershipIds),
          lte(timesheetPeriods.periodStart, query.endDate),
          gte(timesheetPeriods.periodEnd, query.startDate),
        ],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );
    const timesheetsWhere = read.compose(
      {
        tenant: timesheets.orgId,
        scope: membershipScope(actorMembId, timesheets.userMembershipId),
        and: [
          inArray(timesheets.userMembershipId, membershipIds),
          isNull(timesheets.voidedAt),
          gte(timesheets.date, query.startDate),
          lte(timesheets.date, query.endDate),
        ],
      },
      ({ sql: w }) => w,
      () => sql`false`,
    );

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
        .where(periodsWhere),
      this.db
        .select({
          userMembershipId: timesheets.userMembershipId,
          date: timesheets.date,
          hours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)::text`,
        })
        .from(timesheets)
        .where(timesheetsWhere)
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
      const identity = identityByUserId.get(userId);
      return {
        userId,
        name: identity?.name ?? null,
        email: identity?.email ?? null,
        period: membId != null ? periodByMembId.get(membId) ?? null : null,
        dailyHours: membId != null ? dailyByMembId.get(membId) ?? {} : {},
        totalHours: membId != null ? totalByMembId.get(membId) ?? 0 : 0,
      };
    });

    return { summaries };
  }
}
