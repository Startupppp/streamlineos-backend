import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
} from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
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
import type { CompOffInput } from "./dto/leaves.schemas";
import { resolveLeavesViewScope } from "./leaves-scope";
import { HrPolicyEvaluationService } from "../hr-policies/hr-policy-evaluation.service";
import { LeaveLedgerService } from "./leave-ledger.service";

const COMP_OFF_LEAVE_TYPE_NAME = "Compensatory Off";
const DEFAULT_COMP_OFF_MAX_ACCRUAL = 30;
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
    @Optional() private readonly policyEval: HrPolicyEvaluationService,
    @Optional() private readonly ledger: LeaveLedgerService,
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

  async my(orgId: string, userId: string) {
    const [requests, balances] = await Promise.all([
      this.db.query.leaveRequests.findMany({
        where: and(eq(leaveRequests.userId, userId), eq(leaveRequests.orgId, orgId)),
        with: {
          leaveType: { columns: { id: true, name: true, daysPerYear: true } },
          approver: { columns: { id: true, name: true, firstName: true, lastName: true } },
        },
        orderBy: [desc(leaveRequests.createdAt)],
        limit: 200,
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

    const [pending, all] = await Promise.all([
      this.queryLeaves(pendingConditions, orgId, userId, isAll),
      this.db.query.leaveRequests.findMany({
        where: and(...baseConditions),
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
      limit: 100,
    });
  }

  async analytics(u: CurrentUserContext, year: number) {
    const scope = await resolveLeavesViewScope(this.access, u);
    if (scope === "none") throw new ForbiddenException("Forbidden");

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
          approved: sql<number>`SUM(CASE WHEN ${leaveRequests.status} = 'APPROVED' THEN 1 ELSE 0 END)`.mapWith(Number),
          pending: sql<number>`SUM(CASE WHEN ${leaveRequests.status} = 'PENDING' THEN 1 ELSE 0 END)`.mapWith(Number),
          rejected: sql<number>`SUM(CASE WHEN ${leaveRequests.status} = 'REJECTED' THEN 1 ELSE 0 END)`.mapWith(Number),
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
      .limit(200);

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

  async compOff(u: CurrentUserContext, input: CompOffInput) {
    const scope = await resolveLeavesViewScope(this.access, u);
    if (scope === "none") throw new ForbiddenException("Not authorized to grant comp-off");

    const maxAccrual = await this.resolveCompOffMaxAccrual(u.orgId, input.userId);

    let compOffType = await this.db.query.leaveTypes.findFirst({
      where: and(
        eq(leaveTypes.orgId, u.orgId),
        eq(leaveTypes.name, COMP_OFF_LEAVE_TYPE_NAME),
      ),
    });

    if (!compOffType) {
      const [created] = await this.db
        .insert(leaveTypes)
        .values({
          orgId: u.orgId,
          name: COMP_OFF_LEAVE_TYPE_NAME,
          daysPerYear: maxAccrual,
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
        eq(leaveBalances.orgId, u.orgId),
      ),
    });

    await this.db.transaction(async (tx) => {
      if (existing) {
        const newBalance = Number(existing.balance ?? 0) + input.days;
        await tx
          .update(leaveBalances)
          .set({ balance: String(newBalance) })
          .where(eq(leaveBalances.id, existing.id));
      } else {
        await tx.insert(leaveBalances).values({
          orgId: u.orgId,
          userId: input.userId,
          leaveTypeId: compOffType!.id,
          balance: String(input.days),
          year: new Date().getFullYear(),
        });
      }

      if (this.ledger) {
        await this.ledger.write(
          {
            orgId: u.orgId,
            userId: input.userId,
            leaveTypeId: compOffType!.id,
            txnType: "comp_off_earn",
            days: input.days,
            effectiveDate: new Date().toISOString().slice(0, 10),
            source: "manual",
            note: "Comp-off granted by manager",
            createdBy: u.userId,
          },
          tx,
        );
      }
    });

    return { success: true, credited: input.days, leaveTypeId: compOffType.id };
  }

  private async resolveCompOffMaxAccrual(orgId: string, userId: string): Promise<number> {
    if (!this.policyEval) return DEFAULT_COMP_OFF_MAX_ACCRUAL;
    try {
      const result = await this.policyEval.evaluatePolicy(
        orgId,
        userId,
        "comp_off",
        new Date().toISOString().slice(0, 10),
      );
      if (!result) return DEFAULT_COMP_OFF_MAX_ACCRUAL;
      const rules = result.rules as Record<string, unknown>;
      const maxAccrual =
        typeof rules["maxAccrual"] === "number" ? rules["maxAccrual"] : null;
      return maxAccrual ?? DEFAULT_COMP_OFF_MAX_ACCRUAL;
    } catch {
      return DEFAULT_COMP_OFF_MAX_ACCRUAL;
    }
  }
}
