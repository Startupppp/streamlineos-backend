import { ForbiddenException, Inject, Injectable, Optional } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
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
import type { DataScope } from "../../access/access.types";
import { LeaveLedgerService } from "./leave-ledger.service";

const TEAM_LEAVES_CAP = 500;

const TEAM_RELATIONS = {
  user: {
    columns: {
      id: true as const,
      name: true as const,
      firstName: true as const,
      lastName: true as const,
      email: true as const,
      image: true as const,
      designation: true as const,
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

  balance(orgId: string, userId: string) {
    return this.db.query.leaveBalances.findMany({
      where: and(
        eq(leaveBalances.userId, userId),
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
    const rows = await this.db.query.leaveRequests.findMany({
      where: and(
        eq(leaveRequests.userId, userId),
        eq(leaveRequests.orgId, orgId),
        query.cursor ? lt(leaveRequests.id, query.cursor) : undefined,
      ),
      with: {
        leaveType: { columns: { id: true, name: true, daysPerYear: true } },
        approver: { columns: { id: true, name: true, firstName: true, lastName: true } },
      },
      orderBy: [desc(leaveRequests.id)],
      limit: query.limit + 1,
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

  async team(u: CurrentUserContext) {
    const scope = await resolveLeavesViewScope(this.access, u);

    if (scope === "none") {
      throw new ForbiddenException("You do not have permission to view team leave requests.");
    }

    const orgId = u.orgId;
    const userId = u.userId;
    const isAll = scope === "all";

    const baseConditions: SQL[] = isAll
      ? [eq(leaveRequests.orgId, orgId)]
      : [eq(leaveRequests.orgId, orgId), eq(leaveRequests.approverId, userId)];

    const pendingConditions: SQL[] = [...baseConditions, eq(leaveRequests.status, "PENDING")];

    const historyStart = new Date();
    historyStart.setFullYear(historyStart.getFullYear() - 1);

    const [pending, all] = await Promise.all([
      this.queryLeaves(pendingConditions, orgId, userId, isAll),
      this.db.query.leaveRequests.findMany({
        where: and(...baseConditions, gte(leaveRequests.createdAt, historyStart)),
        with: TEAM_RELATIONS,
        orderBy: [desc(leaveRequests.createdAt)],
        limit: TEAM_LEAVES_CAP,
      }),
    ]);

    return { pending, all };
  }

  private async queryLeaves(conditions: SQL[], orgId: string, userId: string, isAll: boolean) {
    const base = await this.db.query.leaveRequests.findMany({
      where: and(...conditions),
      with: TEAM_RELATIONS,
      orderBy: [desc(leaveRequests.createdAt)],
      limit: TEAM_LEAVES_CAP,
    });

    if (isAll) return base;

    const reportingUserIds = await this.employment.getDirectReportUserIds(orgId, userId);

    if (reportingUserIds.length === 0) return base;
    const alreadyFetchedIds = new Set(base.map((r) => r.id));

    const reporteeRequests = await this.db.query.leaveRequests.findMany({
      where: and(
        eq(leaveRequests.orgId, orgId),
        eq(leaveRequests.status, "PENDING"),
        inArray(leaveRequests.userId, reportingUserIds),
      ),
      with: TEAM_RELATIONS,
      orderBy: [desc(leaveRequests.createdAt)],
      limit: TEAM_LEAVES_CAP,
    });

    const extra = reporteeRequests.filter((r) => !alreadyFetchedIds.has(r.id));

    return [...base, ...extra];
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
            email: true,
            image: true,
          },
        },
        leaveType: { columns: { id: true, name: true } },
      },
      orderBy: [desc(leaveRequests.startDate)],
      limit: 100,
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
    if (scope === "none") throw new ForbiddenException("Forbidden");

    return this.cache.cachedVersioned(
      CACHE_KEYS.leaveAnalyticsNamespace(u.orgId),
      `${scope}:${u.userId}:${year}`,
      () => this.queryAnalytics(u.orgId, u.userId, scope, year),
      CACHE_TTL.MEDIUM,
    );
  }

  private async queryAnalytics(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
    year: number,
  ) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const visible = leaveApprovalScope(scope, orgId, actorUserId);

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
        .innerJoin(orgUnitMembers, eq(orgUnitMembers.userId, leaveRequests.userId))
        .innerJoin(orgUnits, eq(orgUnits.id, orgUnitMembers.orgUnitId))
        .where(
          and(
            eq(leaveRequests.orgId, orgId),
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
            eq(leaveRequests.orgId, orgId),
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
            eq(leaveRequests.orgId, orgId),
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
        .innerJoin(orgUnitMembers, eq(orgUnitMembers.userId, leaveRequests.userId))
        .innerJoin(orgUnits, eq(orgUnits.id, orgUnitMembers.orgUnitId))
        .where(
          and(
            eq(leaveRequests.orgId, orgId),
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

  async calendar(orgId: string, month: number, year: number) {
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const rows = await this.db
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
        ),
      )
      .limit(500);

    const leaveTypeIds = [
      ...new Set(rows.map((r) => r.leaveTypeId).filter((id): id is number => id !== null)),
    ];
    let leaveTypeMap = new Map<number, string>();
    if (leaveTypeIds.length > 0) {
      const types = await this.db
        .select({ id: leaveTypes.id, name: leaveTypes.name })
        .from(leaveTypes)
        .where(inArray(leaveTypes.id, leaveTypeIds));
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
