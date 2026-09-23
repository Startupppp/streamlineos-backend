import { ForbiddenException, Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import {
  leaveBalances,
  leaveRequests,
  leaveTypes,
  orgUnitMembers,
  orgUnits,
  organizationMembers,
  users,
} from "../../../db/schema";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { leaveApprovalScope, resolveLeavesViewScope } from "./leaves-scope";
import type { ScopedRead } from "../../access/scoped-read";
import { LeaveLedgerService } from "./leave-ledger.service";
import { requireOrganizationMembershipId } from "./organization-membership";
import { boundHrReadLimit, HR_SCAN_MAX_PAGES, HR_SCAN_PAGE } from "../hr-read-limits";
import type { ListTeamLeaveRequestsQuery } from "./dto/leaves.schemas";
import { pendingLeavesRoutedToPage, type LeaveInboxRow } from "./leave-inbox-reads";
import type { DescKeysetPosition } from "../../../common/pagination/desc-keyset";

const TEAM_LEAVES_CAP = 500;

// Display identity only — `leavesTeamItemSchema.user` exposes nothing more, and designation is an employment fact.
const TEAM_RELATIONS = {
  user: {
    columns: {
      id: true as const,
      name: true as const,
      firstName: true as const,
      lastName: true as const,
      image: true as const,
    },
  },
  leaveType: { columns: { id: true as const, name: true as const } },
  approver: {
    columns: {
      id: true as const,
      name: true as const,
      firstName: true as const,
      lastName: true as const,
    },
  },
};

@Injectable()
export class LeavesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    @Optional() private readonly ledger: LeaveLedgerService,
    private readonly employment: EmploymentFactsService,
  ) {}

  async balance(orgId: string, userId: string) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);
    return this.db.query.leaveBalances.findMany({
      where: and(
        eq(leaveBalances.userMembershipId, userMembershipId),
        eq(leaveBalances.orgId, orgId),
        eq(leaveBalances.year, new Date().getFullYear()),
      ),
      limit: 50,
    });
  }

  async my(
    orgId: string,
    userId: string,
    query: { cursor?: number; limit: number },
  ) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);
    const rows = await this.db.query.leaveRequests.findMany({
      limit: query.limit + 1,
      where: and(
        eq(leaveRequests.userMembershipId, userMembershipId),
        eq(leaveRequests.orgId, orgId),
        query.cursor ? lt(leaveRequests.id, query.cursor) : undefined,
      ),
      with: {
        leaveType: { columns: { id: true, name: true, daysPerYear: true } },
        approver: { columns: { id: true, name: true, firstName: true, lastName: true } },
      },
      orderBy: [desc(leaveRequests.id)],
    });
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      data,
      pageInfo: {
        limit: query.limit,
        hasMore,
        nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null,
      },
    };
  }

  /**
   * One keyset page of the requests the caller may decide on. Scope resolves to the
   * server-assigned approver; an own-scoped manager additionally sees their direct
   * reports' PENDING requests, folded into the same predicate so the cursor stays
   * monotonic across both sources.
   */
  async team(u: CurrentUserContext, query: ListTeamLeaveRequestsQuery) {
    const scope = await resolveLeavesViewScope(this.access, u);

    if (scope.denied) {
      throw new ForbiddenException("You do not have permission to view team leave requests.");
    }

    const orgId = u.orgId;
    const userId = u.userId;
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);
    const limit = boundHrReadLimit(query.limit);

    const visible = scope.compose(
      { tenant: leaveRequests.orgId, scope: leaveApprovalScope(userMembershipId) },
      ({ sql: where }) => where,
      () => sql`false`,
    );
    const reporteePending = scope.unrestricted
      ? undefined
      : await this.directReportsPendingPredicate(orgId, userId);

    const rows = await this.db.query.leaveRequests.findMany({
      where: and(
        eq(leaveRequests.orgId, orgId),
        reporteePending ? or(visible, reporteePending) : visible,
        query.cursor ? lt(leaveRequests.id, query.cursor) : undefined,
        query.status ? eq(leaveRequests.status, query.status) : undefined,
        query.leaveTypeId ? eq(leaveRequests.leaveTypeId, query.leaveTypeId) : undefined,
        query.to ? lte(leaveRequests.startDate, query.to) : undefined,
        query.from ? gte(leaveRequests.endDate, query.from) : undefined,
      ),
      with: TEAM_RELATIONS,
      orderBy: [desc(leaveRequests.id)],
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    return {
      data,
      pageInfo: {
        limit,
        hasMore,
        nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null,
      },
    };
  }

  async pendingRoutedTo(orgId: string, approverMembershipId: number, limit: number) {
    return this.db.query.leaveRequests.findMany({
      where: and(
        eq(leaveRequests.orgId, orgId),
        eq(leaveRequests.status, "PENDING"),
        eq(leaveRequests.approverMembershipId, approverMembershipId),
      ),
      with: TEAM_RELATIONS,
      orderBy: [asc(leaveRequests.createdAt)],
      limit: Math.min(limit, TEAM_LEAVES_CAP),
    });
  }

  async pendingRoutedToPage(
    orgId: string,
    approverMembershipId: number,
    limit: number,
    cursor: DescKeysetPosition | null,
  ): Promise<LeaveInboxRow[]> {
    return pendingLeavesRoutedToPage(
      this.db,
      orgId,
      approverMembershipId,
      Math.min(limit, TEAM_LEAVES_CAP),
      cursor,
    );
  }

  private async directReportsPendingPredicate(orgId: string, userId: string): Promise<SQL | undefined> {
    const reportingUserIds = await this.employment.getDirectReportUserIds(orgId, userId);
    if (reportingUserIds.length === 0) return undefined;

    const reporteeMemberships = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        inArray(organizationMembers.userId, reportingUserIds),
      ))
      .limit(reportingUserIds.length);
    if (reporteeMemberships.length === 0) return undefined;

    return and(
      eq(leaveRequests.orgId, orgId),
      eq(leaveRequests.status, "PENDING"),
      inArray(leaveRequests.userMembershipId, reporteeMemberships.map((member) => member.id)),
    );
  }

  async thisWeek(orgId: string) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const rows = await this.db.query.leaveRequests.findMany({
      limit: 100,
      where: and(
        eq(leaveRequests.orgId, orgId),
        eq(leaveRequests.status, "APPROVED"),
        lte(leaveRequests.startDate, weekEnd.toISOString()),
        gte(leaveRequests.endDate, weekStart.toISOString()),
      ),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            image: true,
          },
        },
        leaveType: { columns: { id: true, name: true } },
      },
      orderBy: [desc(leaveRequests.startDate)],
    });

    const facts = await this.employment.getFactsBatch(
      orgId,
      rows.map((row) => row.user?.id).filter((id): id is string => Boolean(id)),
    );

    return rows.map((row) => ({
      ...row,
      user: row.user
        ? { ...row.user, designation: facts.get(row.user.id)?.designation ?? null }
        : row.user,
    }));
  }

  async analytics(u: CurrentUserContext, year: number) {
    const scope = await resolveLeavesViewScope(this.access, u);
    if (scope.denied) throw new ForbiddenException("Forbidden");

    const actorMembershipId = await requireOrganizationMembershipId(this.db, u.orgId, u.userId);
    return this.cache.cachedVersioned(
      CACHE_KEYS.leaveAnalyticsNamespace(u.orgId),
      `${scope.discriminator}:${year}`,
      () => this.queryAnalytics(scope, actorMembershipId, year),
      CACHE_TTL.MEDIUM,
    );
  }

  private async queryAnalytics(
    scope: ScopedRead,
    actorMembershipId: number,
    year: number,
  ) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const visible = scope.compose(
      { tenant: leaveRequests.orgId, scope: leaveApprovalScope(actorMembershipId) },
      ({ sql: where }) => where,
      () => sql`false`,
    );

    const [byDept, monthly, byType, deptAvgDays] = await Promise.all([
      this.db
        .select({
          department: orgUnits.name,
          total: count(leaveRequests.id),
          approved: sql<number>`SUM(CASE WHEN ${leaveRequests.status} = 'APPROVED' THEN 1 ELSE 0 END)`.mapWith(Number),
          pending: sql<number>`SUM(CASE WHEN ${leaveRequests.status} = 'PENDING' THEN 1 ELSE 0 END)`.mapWith(Number),
          rejected: sql<number>`SUM(CASE WHEN ${leaveRequests.status} = 'REJECTED' THEN 1 ELSE 0 END)`.mapWith(Number),
        })
        .from(leaveRequests)
        .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, leaveRequests.orgId), eq(organizationMembers.id, leaveRequests.userMembershipId)))
        .innerJoin(orgUnitMembers, eq(orgUnitMembers.membershipId, organizationMembers.id))
        .innerJoin(orgUnits, eq(orgUnits.id, orgUnitMembers.orgUnitId))
        .where(
          and(
            visible,
            gte(leaveRequests.startDate, yearStart),
            lte(leaveRequests.startDate, yearEnd),
            eq(orgUnits.kind, "DEPARTMENT"),
          ),
        )
        .groupBy(orgUnits.name),

      this.db
        .select({
          month: sql<string>`TO_CHAR(${leaveRequests.startDate}::date, 'Mon')`,
          monthNum: sql<number>`EXTRACT(MONTH FROM ${leaveRequests.startDate}::date)`.mapWith(Number),
          count: count(leaveRequests.id),
        })
        .from(leaveRequests)
        .where(
          and(
            visible,
            eq(leaveRequests.status, "APPROVED"),
            gte(leaveRequests.startDate, yearStart),
            lte(leaveRequests.startDate, yearEnd),
          ),
        )
        .groupBy(
          sql`TO_CHAR(${leaveRequests.startDate}::date, 'Mon')`,
          sql`EXTRACT(MONTH FROM ${leaveRequests.startDate}::date)`,
        )
        .orderBy(sql`EXTRACT(MONTH FROM ${leaveRequests.startDate}::date)`),

      this.db
        .select({
          typeName: leaveTypes.name,
          count: count(leaveRequests.id),
        })
        .from(leaveRequests)
        .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
        .where(
          and(
            visible,
            eq(leaveRequests.status, "APPROVED"),
            gte(leaveRequests.startDate, yearStart),
            lte(leaveRequests.startDate, yearEnd),
          ),
        )
        .groupBy(leaveTypes.name),

      this.db
        .select({
          department: orgUnits.name,
          avgDays: sql<number>`ROUND(AVG(
            (${leaveRequests.endDate}::date - ${leaveRequests.startDate}::date) + 1
          ), 1)`.mapWith(Number),
        })
        .from(leaveRequests)
        .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, leaveRequests.orgId), eq(organizationMembers.id, leaveRequests.userMembershipId)))
        .innerJoin(orgUnitMembers, eq(orgUnitMembers.membershipId, organizationMembers.id))
        .innerJoin(orgUnits, eq(orgUnits.id, orgUnitMembers.orgUnitId))
        .where(
          and(
            visible,
            eq(leaveRequests.status, "APPROVED"),
            gte(leaveRequests.startDate, yearStart),
            lte(leaveRequests.startDate, yearEnd),
            eq(orgUnits.kind, "DEPARTMENT"),
          ),
        )
        .groupBy(orgUnits.name),
    ]);

    return {
      year,
      byDepartment: byDept,
      monthlyTrend: monthly.map((m) => ({ month: m.month, count: m.count })),
      byLeaveType: byType.map((t) => ({ typeName: t.typeName, count: t.count })),
      avgDaysByDepartment: deptAvgDays.map((d) => ({
        department: d.department,
        avgDays: d.avgDays ?? 0,
      })),
    };
  }

  /**
   * One capped keyset page of a calendar month. The month is read whole — a day missing
   * a colleague's leave is wrong, not short — so `calendar` walks these pages on the
   * primary key rather than truncating at one oversized read.
   */
  private calendarPage(orgId: string, monthStart: string, monthEnd: string, afterId: number) {
    return this.db
      .select({
        id: leaveRequests.id,
        userId: leaveRequests.userId,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        status: leaveRequests.status,
        leaveTypeId: leaveRequests.leaveTypeId,
        userName: users.name,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userImage: users.image,
      })
      .from(leaveRequests)
      .innerJoin(users, eq(leaveRequests.userId, users.id))
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          lte(leaveRequests.startDate, monthEnd),
          gte(leaveRequests.endDate, monthStart),
          gt(leaveRequests.id, afterId),
        ),
      )
      .orderBy(asc(leaveRequests.id))
      .limit(HR_SCAN_PAGE);
  }

  async calendar(orgId: string, month: number, year: number) {
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const rows: Awaited<ReturnType<LeavesService["calendarPage"]>> = [];
    let afterId = 0;
    for (let page = 0; page < HR_SCAN_MAX_PAGES; page++) {
      const chunk = await this.calendarPage(orgId, monthStart, monthEnd, afterId);
      rows.push(...chunk);
      if (chunk.length < HR_SCAN_PAGE) break;
      afterId = chunk[chunk.length - 1].id;
    }

    const leaveTypeIds = [
      ...new Set(rows.map((r) => r.leaveTypeId).filter((id): id is number => id !== null)),
    ];
    let leaveTypeMap = new Map<number, string>();
    if (leaveTypeIds.length > 0) {
      const types = await this.db
        .select({ id: leaveTypes.id, name: leaveTypes.name })
        .from(leaveTypes)
        .where(inArray(leaveTypes.id, leaveTypeIds))
        .limit(leaveTypeIds.length);
      leaveTypeMap = new Map(types.map((t) => [t.id, t.name]));
    }

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName:
        (r.userName ?? [r.userFirstName, r.userLastName].filter(Boolean).join(" ")) || "Unknown",
      userImage: r.userImage,
      startDate: r.startDate,
      endDate: r.endDate,
      leaveType: r.leaveTypeId ? (leaveTypeMap.get(r.leaveTypeId) ?? "Leave") : "Leave",
      status: r.status ?? "PENDING",
    }));
  }

  async teamAvailability(orgId: string, startDate: string, endDate: string) {
    const rows = await this.db
      .select({
        userId: leaveRequests.userId,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        leaveTypeId: leaveRequests.leaveTypeId,
        userName: users.name,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userImage: users.image,
      })
      .from(leaveRequests)
      .innerJoin(users, eq(leaveRequests.userId, users.id))
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          eq(leaveRequests.status, "APPROVED"),
          lte(leaveRequests.startDate, endDate),
          gte(leaveRequests.endDate, startDate),
        ),
      )
      .limit(100);

    return rows.map((r) => ({
      userId: r.userId,
      displayName:
        (r.userName ?? [r.userFirstName, r.userLastName].filter(Boolean).join(" ")) || "Unknown",
      userImage: r.userImage,
      startDate: r.startDate,
      endDate: r.endDate,
      leaveTypeId: r.leaveTypeId,
    }));
  }

  async leaveSummary(orgId: string, periodStart: string, periodEnd: string) {
    if (!this.ledger) return [];
    return this.ledger.buildLeaveSummary(orgId, periodStart, periodEnd);
  }

}
