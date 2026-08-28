import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  holidays,
  hrEmployments,
  hrPeople,
  leaveBalances,
  leaveRequests,
  leaveTypes,
  resignations,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { getTodayString } from "../../common/date";
import { type DashboardForbidden } from "./dashboard.errors";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { resolveLeavesDashboardScope } from "./dashboard-scope";
import { resignationApprovalScope } from "./resignation-approval-scope";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";
import { leaveApprovalScope } from "../hr/time/leaves-scope";

@Injectable()
export class DashboardLeaveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  getLeavesToday(orgId: string) {
    const today = getTodayString();
    return this.db
      .select({
        id: leaveRequests.id,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        leaveTypeId: leaveRequests.leaveTypeId,
        employeeName: users.name,
        employeeDesignation: hrEmployments.designation,
        employeeImage: users.image,
      })
      .from(leaveRequests)
      .innerJoin(users, eq(leaveRequests.userId, users.id))
      .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          eq(leaveRequests.status, "APPROVED"),
          lte(leaveRequests.startDate, today),
          gte(leaveRequests.endDate, today),
        ),
      );
  }

  getMyLeaveBalance(orgId: string, userId: string) {
    const currentYear = new Date().getFullYear();
    const key = `dashboard:my-leave-balance:${orgId}:${userId}:${currentYear}`;
    return this.cache.cached(
      key,
      () =>
        this.db
          .select({
            id: leaveBalances.id,
            balance: leaveBalances.balance,
            year: leaveBalances.year,
            leaveTypeName: leaveTypes.name,
            daysPerYear: leaveTypes.daysPerYear,
          })
          .from(leaveBalances)
          .leftJoin(leaveTypes, eq(leaveBalances.leaveTypeId, leaveTypes.id))
          .where(
            and(
              eq(leaveBalances.orgId, orgId),
              eq(leaveBalances.userId, userId),
              eq(leaveBalances.year, currentYear),
            ),
          ),
      CACHE_TTL.SHORT,
    );
  }

  async getPendingApprovals(orgId: string, u: CurrentUserContext) {
    const scope = await resolveLeavesDashboardScope(this.access, u);
    if (scope === "none") {
      return { error: "forbidden", message: "Forbidden" } as DashboardForbidden;
    }

    const isApprover = await this.access.holds(u, "hr:leaves:approve");
    // Below "all" the count is per-approver, so the key carries the actor too.
    const audience = scope === "all" ? "org" : u.userId;
    const key = `dashboard:pending-approvals:${orgId}:${scope}:${audience}:${isApprover ? "approver" : "self"}`;
    const visible = leaveApprovalScope(scope, orgId, u.userId);

    return this.cache.cached(
      key,
      async () => {
        const [leaveCount] = await this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(leaveRequests)
          .where(
            and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "PENDING"), visible),
          );

        const resignationStatuses = isApprover ? ["SUBMITTED", "PENDING_HR"] : ["HR_APPROVED"];

        const [resignationCount] = await this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(resignations)
          .where(
            and(
              eq(resignations.orgId, orgId),
              inArray(
                resignations.status,
                resignationStatuses as ("SUBMITTED" | "PENDING_HR" | "HR_APPROVED")[],
              ),
              resignationApprovalScope(scope, orgId, u.userId),
            ),
          );

        const pendingLeaves = leaveCount?.count ?? 0;
        const pendingResignations = resignationCount?.count ?? 0;

        return {
          pendingLeaves,
          pendingResignations,
          total: pendingLeaves + pendingResignations,
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  getUpcomingHolidays(orgId: string) {
    const today = getTodayString();
    const key = `dashboard:upcoming-holidays:${orgId}:${today}`;
    return this.cache.cached(
      key,
      () =>
        this.db
          .select({
            id: holidays.id,
            name: holidays.name,
            date: holidays.date,
            message: holidays.message,
          })
          .from(holidays)
          .where(and(eq(holidays.orgId, orgId), gte(holidays.date, today)))
          .orderBy(asc(holidays.date))
          .limit(3),
      CACHE_TTL.HOUR,
    );
  }
}
