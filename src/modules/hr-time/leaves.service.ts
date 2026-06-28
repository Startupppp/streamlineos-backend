import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, count, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  departmentMembers,
  departments,
  leaveBalances,
  leaveRequests,
  leaveTypes,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
import type { CompOffInput } from "./dto/leaves.schemas";

const COMP_OFF_LEAVE_NAME = "Compensatory Off";
const TEAM_LEAVES_CAP = 500;
const ANALYTICS_ROLES = ["CEO", "ADMIN", "HR", "BRANCH_HR", "BRANCH_MANAGER"];

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
  ) {}

  balance(orgId: string, userId: string) {
    return this.db.query.leaveBalances.findMany({
      where: and(
        eq(leaveBalances.userId, userId),
        eq(leaveBalances.orgId, orgId),
        eq(leaveBalances.year, new Date().getFullYear()),
      ),
    });
  }

  async my(orgId: string, userId: string) {
    const [requests, balances] = await Promise.all([
      this.db.query.leaveRequests.findMany({
        where: and(eq(leaveRequests.userId, userId), eq(leaveRequests.orgId, orgId)),
        with: {
          leaveType: { columns: { id: true, name: true, daysPerYear: true } },
          approver: { columns: { id: true, name: true, firstName: true, lastName: true } },
        },
        orderBy: [desc(leaveRequests.createdAt)],
      }),
      this.db.query.leaveBalances.findMany({
        where: and(
          eq(leaveBalances.userId, userId),
          eq(leaveBalances.orgId, orgId),
          eq(leaveBalances.year, new Date().getFullYear()),
        ),
        with: {
          leaveType: { columns: { id: true, name: true, daysPerYear: true } },
        },
      }),
    ]);

    return { requests, balances };
  }

  async team(u: CurrentUserContext) {
    const role = u.role ?? "";
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || perms.has("hr:leaves:approve");

    if (!isAdmin && role !== "MANAGER" && role !== "BRANCH_MANAGER") {
      throw new ForbiddenException("Only managers and admins can access team leave requests.");
    }

    const orgId = u.orgId;
    const userId = u.userId;

    const baseConditions: SQL[] = isAdmin
      ? [eq(leaveRequests.orgId, orgId)]
      : [eq(leaveRequests.orgId, orgId), eq(leaveRequests.approverId, userId)];

    const pendingConditions: SQL[] = [...baseConditions, eq(leaveRequests.status, "PENDING")];

    const [pending, all] = await Promise.all([
      this.queryLeaves(pendingConditions, orgId, userId, isAdmin),
      this.db.query.leaveRequests.findMany({
        where: and(...baseConditions),
        with: TEAM_RELATIONS,
        orderBy: [desc(leaveRequests.createdAt)],
        limit: TEAM_LEAVES_CAP,
      }),
    ]);

    return { pending, all };
  }

  private async queryLeaves(conditions: SQL[], orgId: string, userId: string, isAdmin: boolean) {
    const base = await this.db.query.leaveRequests.findMany({
      where: and(...conditions),
      with: TEAM_RELATIONS,
      orderBy: [desc(leaveRequests.createdAt)],
      limit: TEAM_LEAVES_CAP,
    });

    if (isAdmin) return base;

    const reportingUsers = await this.db.query.users.findMany({
      where: eq(users.reportingTo, userId),
      columns: { id: true },
    });

    if (reportingUsers.length === 0) return base;

    const reportingUserIds = new Set(reportingUsers.map((r) => r.id));
    const alreadyFetchedIds = new Set(base.map((r) => r.id));

    const reporteeRequests = await this.db.query.leaveRequests.findMany({
      where: and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "PENDING")),
      with: TEAM_RELATIONS,
      orderBy: [desc(leaveRequests.createdAt)],
      limit: TEAM_LEAVES_CAP,
    });

    const extra = reporteeRequests.filter(
      (r) => !alreadyFetchedIds.has(r.id) && reportingUserIds.has(r.userId),
    );

    return [...base, ...extra];
  }

  thisWeek(orgId: string) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    return this.db.query.leaveRequests.findMany({
      where: and(
        eq(leaveRequests.orgId, orgId),
        eq(leaveRequests.status, "APPROVED"),
        lte(leaveRequests.startDate, weekEnd.toISOString()),
        gte(leaveRequests.endDate, weekStart.toISOString()),
      ),
      with: {
        user: true,
        leaveType: { columns: { id: true, name: true } },
      },
      orderBy: [desc(leaveRequests.startDate)],
    });
  }

  analytics(u: CurrentUserContext, year: number) {
    if (!hasRoleOrPrivileged(u, ANALYTICS_ROLES)) {
      throw new ForbiddenException("Forbidden");
    }

    const cacheKey = `hr:leave-analytics:${u.orgId}:${year}`;
    return this.cache.cached(cacheKey, () => this.queryAnalytics(u.orgId, year), CACHE_TTL.MEDIUM);
  }

  private async queryAnalytics(orgId: string, year: number) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const [byDept, monthly, byType, deptAvgDays] = await Promise.all([
      this.db
        .select({
          department: departments.name,
          total: count(leaveRequests.id),
          approved: sql<number>`SUM(CASE WHEN ${leaveRequests.status} = 'APPROVED' THEN 1 ELSE 0 END)`.mapWith(
            Number,
          ),
          pending: sql<number>`SUM(CASE WHEN ${leaveRequests.status} = 'PENDING' THEN 1 ELSE 0 END)`.mapWith(
            Number,
          ),
          rejected: sql<number>`SUM(CASE WHEN ${leaveRequests.status} = 'REJECTED' THEN 1 ELSE 0 END)`.mapWith(
            Number,
          ),
        })
        .from(leaveRequests)
        .innerJoin(departmentMembers, eq(departmentMembers.userId, leaveRequests.userId))
        .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
        .where(
          and(
            eq(leaveRequests.orgId, orgId),
            gte(leaveRequests.startDate, yearStart),
            lte(leaveRequests.startDate, yearEnd),
          ),
        )
        .groupBy(departments.name),

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
            eq(leaveRequests.status, "APPROVED"),
            gte(leaveRequests.startDate, yearStart),
            lte(leaveRequests.startDate, yearEnd),
          ),
        )
        .groupBy(leaveTypes.name),

      this.db
        .select({
          department: departments.name,
          avgDays: sql<number>`ROUND(AVG(
            (${leaveRequests.endDate}::date - ${leaveRequests.startDate}::date) + 1
          ), 1)`.mapWith(Number),
        })
        .from(leaveRequests)
        .innerJoin(departmentMembers, eq(departmentMembers.userId, leaveRequests.userId))
        .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
        .where(
          and(
            eq(leaveRequests.orgId, orgId),
            eq(leaveRequests.status, "APPROVED"),
            gte(leaveRequests.startDate, yearStart),
            lte(leaveRequests.startDate, yearEnd),
          ),
        )
        .groupBy(departments.name),
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
      );

    const leaveTypeIds = [...new Set(rows.map((r) => r.leaveTypeId).filter(Boolean))];
    let leaveTypeMap = new Map<number, string>();
    if (leaveTypeIds.length > 0) {
      const firstId = leaveTypeIds[0];
      const types = await this.db
        .select({ id: leaveTypes.id, name: leaveTypes.name })
        .from(leaveTypes)
        .where(
          leaveTypeIds.length === 1 && firstId !== undefined
            ? eq(leaveTypes.id, firstId)
            : eq(leaveTypes.orgId, orgId),
        );
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

  async compOff(u: CurrentUserContext, input: CompOffInput) {
    if (!hasRoleOrPrivileged(u, ANALYTICS_ROLES)) {
      throw new ForbiddenException("Forbidden");
    }

    let compOffType = await this.db.query.leaveTypes.findFirst({
      where: and(eq(leaveTypes.orgId, u.orgId), eq(leaveTypes.name, COMP_OFF_LEAVE_NAME)),
    });

    if (!compOffType) {
      const [created] = await this.db
        .insert(leaveTypes)
        .values({
          orgId: u.orgId,
          name: COMP_OFF_LEAVE_NAME,
          daysPerYear: 30,
          carryForward: false,
        })
        .returning();
      compOffType = created;
    }

    if (!compOffType) {
      throw new InternalServerErrorException("Failed to find/create comp-off leave type");
    }

    const existing = await this.db.query.leaveBalances.findFirst({
      where: and(
        eq(leaveBalances.userId, input.userId),
        eq(leaveBalances.leaveTypeId, compOffType.id),
      ),
    });

    if (existing) {
      const newBalance = Number(existing.balance ?? 0) + input.days;
      await this.db
        .update(leaveBalances)
        .set({ balance: String(newBalance) })
        .where(eq(leaveBalances.id, existing.id));
    } else {
      await this.db.insert(leaveBalances).values({
        orgId: u.orgId,
        userId: input.userId,
        leaveTypeId: compOffType.id,
        balance: String(input.days),
        year: new Date().getFullYear(),
      });
    }

    return { success: true, credited: input.days, leaveTypeId: compOffType.id };
  }
}
