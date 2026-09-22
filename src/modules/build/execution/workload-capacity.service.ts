import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  leaveRequests,
  organizationMembers,
  projectMembers,
  timesheetSettings,
  timesheets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { computeCapacity } from "./capacity.lib";
import { assertProjectInOrg } from "../core/project-access";

@Injectable()
export class WorkloadCapacityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async capacity(orgId: string, projectId: number, start: string, end: string) {
    await assertProjectInOrg(this.db, orgId, projectId);

    const [settings] = await this.db
      .select({ expectedDailyHours: timesheetSettings.expectedDailyHours })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);
    const expectedDailyHours =
      settings?.expectedDailyHours != null ? Number(settings.expectedDailyHours) : null;

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
      .where(and(eq(projectMembers.orgId, orgId), eq(projectMembers.projectId, projectId)));

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
      .groupBy(timesheets.userMembershipId);

    const loggedHoursByMembershipId = new Map<number, number>(
      timesheetRows
        .filter((r) => r.userMembershipId !== null)
        .map((r) => [r.userMembershipId!, Number(r.totalHours)]),
    );

    const members = memberRows.map(({ userId, membershipId }) => {
      const leaves = leavesByUserId.get(userId) ?? [];
      const loggedHours = loggedHoursByMembershipId.get(membershipId) ?? 0;
      const result = computeCapacity({
        windowStart: start,
        windowEnd: end,
        expectedDailyHours,
        loggedHours,
        leaves,
      });
      return { userId, membershipId, ...result };
    });

    return { members };
  }
}
