import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  holidays,
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
import { addDays, formatDateOnly, getTodayString } from "./date.helpers";
import { type DashboardActor, type DashboardForbidden } from "./dashboard.errors";

@Injectable()
export class DashboardLeaveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
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
        employeeDesignation: users.designation,
        employeeImage: users.image,
      })
      .from(leaveRequests)
      .innerJoin(users, eq(leaveRequests.userId, users.id))
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

  async getPendingApprovals(orgId: string, actor: DashboardActor) {
    const canApprove = actor.isPlatformAdmin || actor.isOrgOwner || actor.permissions.includes("hr:leaves:approve");
    if (!canApprove) {
      return { error: "forbidden", message: "Forbidden" } as DashboardForbidden;
    }

    const role = actor.role ?? "";
    const key = `dashboard:pending-approvals:${orgId}:${role}`;

    return this.cache.cached(
      key,
      async () => {
        const [leaveCount] = await this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(leaveRequests)
          .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "PENDING")));

        const resignationStatuses =
          role === "HR" ? ["SUBMITTED", "PENDING_HR"] : ["HR_APPROVED"];

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

  getPendingRequests(orgId: string, userId: string) {
    return this.db
      .select({
        id: leaveRequests.id,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        status: leaveRequests.status,
        reason: leaveRequests.reason,
        createdAt: leaveRequests.createdAt,
        leaveTypeName: leaveTypes.name,
      })
      .from(leaveRequests)
      .innerJoin(leaveTypes, eq(leaveRequests.leaveTypeId, leaveTypes.id))
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          eq(leaveRequests.userId, userId),
          eq(leaveRequests.status, "PENDING"),
        ),
      )
      .orderBy(desc(leaveRequests.createdAt))
      .limit(10);
  }

  getUpcomingLeaves(orgId: string) {
    const today = getTodayString();
    const nextWeek = formatDateOnly(addDays(new Date(), 7));
    const key = `dashboard:upcoming-leaves:${orgId}:${today}`;
    return this.cache.cached(
      key,
      () =>
        this.db
          .select({
            id: leaveRequests.id,
            startDate: leaveRequests.startDate,
            endDate: leaveRequests.endDate,
            leaveTypeId: leaveRequests.leaveTypeId,
            employeeName: users.name,
            employeeDesignation: users.designation,
            employeeImage: users.image,
          })
          .from(leaveRequests)
          .innerJoin(users, eq(leaveRequests.userId, users.id))
          .where(
            and(
              eq(leaveRequests.orgId, orgId),
              eq(leaveRequests.status, "APPROVED"),
              gte(leaveRequests.startDate, today),
              lte(leaveRequests.startDate, nextWeek),
            ),
          ),
      CACHE_TTL.MEDIUM,
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
