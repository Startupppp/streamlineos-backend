import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  leaveRequests,
  organizationMembers,
  projectMembers,
  projectStatuses,
  projectTeams,
  projectTeamMembers,
  tickets,
  timesheetSettings,
  timesheets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { computeCapacity } from "./capacity.lib";
import { assertProjectVisible } from "../core";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class WorkloadCapacityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async capacity(actor: CurrentUserContext, projectId: number, start: string, end: string, teamId?: number) {
    await assertProjectVisible(this.db, this.access, actor, projectId);
    const { orgId } = actor;

    const [settings] = await this.db
      .select({ expectedDailyHours: timesheetSettings.expectedDailyHours })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);
    const expectedDailyHours =
      settings?.expectedDailyHours != null ? Number(settings.expectedDailyHours) : null;

    let teamMembershipIdSet: Set<number> | undefined;
    if (teamId !== undefined) {
      const teamMemberRows = await this.db
        .select({ membershipId: projectTeamMembers.membershipId })
        .from(projectTeamMembers)
        .where(
          and(
            eq(projectTeamMembers.orgId, orgId),
            eq(projectTeamMembers.teamId, teamId),
          ),
        )
        .limit(500);
      if (teamMemberRows.length === 0) return { members: [] };
      teamMembershipIdSet = new Set(teamMemberRows.map((r) => r.membershipId));
    }

    const memberWhere = teamMembershipIdSet !== undefined
      ? and(
          eq(projectMembers.orgId, orgId),
          eq(projectMembers.projectId, projectId),
          inArray(projectMembers.membershipId, [...teamMembershipIdSet]),
        )
      : and(eq(projectMembers.orgId, orgId), eq(projectMembers.projectId, projectId));

    const memberRows = await this.db
      .select({
        userId: organizationMembers.userId,
        membershipId: organizationMembers.id,
      })
      .from(projectMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, projectMembers.membershipId),
          eq(organizationMembers.orgId, projectMembers.orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .where(memberWhere)
      .limit(500);

    if (memberRows.length === 0) return { members: [] };

    const userIds = memberRows.map((m) => m.userId);
    const membershipIds = memberRows.map((m) => m.membershipId);

    const leaveRows = await this.db
      .select({
        userId: leaveRequests.userId,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        isHalfDay: leaveRequests.isHalfDay,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          eq(leaveRequests.status, "APPROVED"),
          lte(leaveRequests.startDate, end),
          gte(leaveRequests.endDate, start),
          inArray(leaveRequests.userId, userIds),
        ),
      )
      .limit(500);

    const leavesByUserId = new Map<
      string,
      Array<{ startDate: string; endDate: string; isHalfDay: boolean }>
    >();
    for (const row of leaveRows) {
      const arr = leavesByUserId.get(row.userId) ?? [];
      arr.push({ startDate: row.startDate, endDate: row.endDate, isHalfDay: row.isHalfDay });
      leavesByUserId.set(row.userId, arr);
    }

    const timesheetRows = await this.db
      .select({
        userMembershipId: timesheets.userMembershipId,
        totalHours: sql<number>`COALESCE(SUM(${timesheets.hours}::numeric), 0)`,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.orgId, orgId),
          eq(timesheets.projectId, projectId),
          eq(timesheets.status, "APPROVED"),
          isNull(timesheets.voidedAt),
          gte(timesheets.date, start),
          lte(timesheets.date, end),
          inArray(timesheets.userMembershipId, membershipIds),
        ),
      )
      .groupBy(timesheets.userMembershipId)
      .limit(500);

    const loggedHoursByMembershipId = new Map<number, number>(
      timesheetRows
        .filter((r) => r.userMembershipId !== null)
        .map((r) => [r.userMembershipId!, Number(r.totalHours)]),
    );

    const estimateRows = await this.db
      .select({
        assigneeMembershipId: tickets.assigneeMembershipId,
        estimateHours: sql<string>`COALESCE(SUM(${tickets.originalEstimate}), 0)`,
        estimatedTicketCount: sql<string>`COUNT(${tickets.originalEstimate})`,
      })
      .from(tickets)
      .leftJoin(
        projectStatuses,
        and(
          eq(projectStatuses.orgId, tickets.orgId),
          eq(projectStatuses.projectId, tickets.projectId),
          eq(projectStatuses.name, tickets.status),
        ),
      )
      .where(
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          isNull(tickets.deletedAt),
          inArray(tickets.assigneeMembershipId, membershipIds),
          sql`${projectStatuses.type} IS DISTINCT FROM 'completed'`,
          sql`${projectStatuses.type} IS DISTINCT FROM 'cancelled'`,
        ),
      )
      .groupBy(tickets.assigneeMembershipId)
      .limit(500);

    const estimateHoursByMembershipId = new Map<number, number | null>(
      estimateRows
        .filter((r) => r.assigneeMembershipId !== null)
        .map((r) => [
          r.assigneeMembershipId!,
          Number(r.estimatedTicketCount) > 0 ? Number(r.estimateHours) : null,
        ]),
    );

    const teamRows = await this.db
      .select({
        membershipId: projectTeamMembers.membershipId,
        teamId: projectTeams.id,
        teamName: projectTeams.name,
      })
      .from(projectTeamMembers)
      .innerJoin(
        projectTeams,
        and(
          eq(projectTeams.orgId, projectTeamMembers.orgId),
          eq(projectTeams.id, projectTeamMembers.teamId),
        ),
      )
      .where(
        and(
          eq(projectTeamMembers.orgId, orgId),
          inArray(projectTeamMembers.membershipId, membershipIds),
          isNull(projectTeams.deletedAt),
        ),
      )
      .limit(500);

    const teamsByMembershipId = new Map<number, Array<{ id: number; name: string }>>();
    for (const row of teamRows) {
      const arr = teamsByMembershipId.get(row.membershipId) ?? [];
      arr.push({ id: row.teamId, name: row.teamName });
      teamsByMembershipId.set(row.membershipId, arr);
    }

    const members = memberRows.map(({ userId, membershipId }) => {
      const leaves = leavesByUserId.get(userId) ?? [];
      const loggedHours = loggedHoursByMembershipId.get(membershipId) ?? 0;
      const result = computeCapacity({
        windowStart: start,
        windowEnd: end,
        expectedDailyHours,
        loggedHours,
        estimateHours: estimateHoursByMembershipId.get(membershipId) ?? null,
        leaves,
      });
      return {
        userId,
        membershipId,
        teams: teamsByMembershipId.get(membershipId) ?? [],
        ...result,
      };
    });

    return { members };
  }
}
