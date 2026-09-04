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
import {
  CACHE_TTL,
  DASHBOARD_PENDING_APPROVALS_NAMESPACE,
} from "../../common/cache/cache-keys";
import { getTodayString } from "../../common/date";
import { type DashboardForbidden } from "./dashboard.errors";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { AccessService } from "../access/access.service";
import { resolveLeavesDashboardScope } from "./dashboard-scope";
import { resignationApprovalScope } from "./resignation-approval-scope";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";
import {
  leaveApprovalScope,
  resolveLeavesViewScope,
} from "../hr/time/leaves-scope";
import { applyScope } from "../access/apply-scope";
import {
  buildOrgSectionCacheKey,
  buildScopedSectionCacheKey,
} from "./dashboard-cache-key";
import {
  boundedDashboardList,
  DASHBOARD_LIST_CAP,
} from "./dashboard-read-limits";

@Injectable()
export class DashboardLeaveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async getLeavesToday(u: CurrentUserContext) {
    const { orgId } = u;
    const approvalScope = await resolveLeavesViewScope(this.access, u);
    const scope = approvalScope === "none" ? "own" : approvalScope;
    const today = getTodayString();
    const visible = and(
      eq(leaveRequests.orgId, orgId),
      eq(leaveRequests.status, "APPROVED"),
      lte(leaveRequests.startDate, today),
      gte(leaveRequests.endDate, today),
      applyScope(scope, orgId, u.userId, {
        ownerColumn: leaveRequests.userId,
      }),
    );

    const [rows, totalRows] = await Promise.all([
      this.db
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
        .where(visible)
        .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.id))
        .limit(DASHBOARD_LIST_CAP),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(leaveRequests)
        .where(visible),
    ]);

    return boundedDashboardList(rows, totalRows[0]?.count ?? rows.length);
  }

  async getMyLeaveBalance(u: CurrentUserContext) {
    const { orgId, userId } = u;
    const currentYear = new Date().getFullYear();
    const key = await buildScopedSectionCacheKey(
      this.access,
      u,
      "leave-balance",
      "own",
      String(currentYear),
    );
    return this.cache.cachedForOrg(
      orgId,
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
    const key = await buildScopedSectionCacheKey(
      this.access,
      u,
      "pending-approvals",
      scope,
      isApprover ? "approver" : "self",
    );
    const visible = leaveApprovalScope(scope, u.principal ? actingMembershipId(u.principal) : null);

    return this.cache.cachedVersionedForOrg(
      orgId,
      DASHBOARD_PENDING_APPROVALS_NAMESPACE,
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

  async getUpcomingHolidays(orgId: string) {
    const today = getTodayString();
    const key = await buildOrgSectionCacheKey(
      this.access,
      orgId,
      "upcoming-holidays",
      today,
    );
    return this.cache.cachedForOrg(
      orgId,
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
