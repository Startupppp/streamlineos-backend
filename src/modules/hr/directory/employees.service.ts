import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SQL, and, avg, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  attendance,
  leaveRequests,
  organizationMembers,
  performanceReviews,
  projectMembers,
  projects,
  tickets,
  users,
} from "../../../db/schema";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { formatDateOnly, subDays } from "../../../common/date";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";

@Injectable()
export class EmployeesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listEmployees(
    orgId: string,
    userId: string,
    opts: {
      page?: number;
      limit?: number;
      search?: string;
      departmentId?: string;
      isActive?: "true" | "false" | "all";
      role?: string;
    },
    scope: DataScope,
  ) {
    const search = opts.search;
    const pageN = opts.page ?? 1;
    const limitN = opts.limit ?? 20;
    const isActive = opts.isActive ?? "true";
    const departmentId = opts.departmentId;
    const role = opts.role?.trim() || undefined;

    const key = `hr:employees:paginated:${orgId}:${userId}:${scope}:${pageN}:${limitN}:${search ?? ""}:${departmentId ?? ""}:${isActive}:${role ?? ""}`;
    return this.cache.cached(
      key,
      () =>
        this.getEmployeesPaginated(
          orgId,
          pageN,
          limitN,
          search,
          userId,
          scope,
          departmentId,
          isActive,
          role,
        ),
      CACHE_TTL.SHORT,
    );
  }

  private async getEmployeesPaginated(
    orgId: string,
    page: number,
    limit: number,
    search: string | undefined,
    userId: string,
    scope: DataScope,
    departmentId?: string,
    isActive: "true" | "false" | "all" = "true",
    role?: string,
  ) {
    const offset = (page - 1) * limit;

    const baseConditions: SQL[] = [
      eq(organizationMembers.orgId, orgId),
      applyScope(scope, orgId, userId, { ownerColumn: organizationMembers.userId }),
    ];
    if (isActive === "true") baseConditions.push(eq(users.isActive, true));
    else if (isActive === "false") baseConditions.push(eq(users.isActive, false));
    if (departmentId != null) baseConditions.push(eq(users.orgDepartmentId, departmentId));
    if (role) baseConditions.push(eq(organizationMembers.role, role));

    const searchCondition = search
      ? or(
          ilike(users.name, `%${search}%`),
          ilike(users.email, `%${search}%`),
          ilike(users.employeeId, `%${search}%`),
          ilike(users.designation, `%${search}%`),
          ilike(users.firstName, `%${search}%`),
          ilike(users.lastName, `%${search}%`),
        )
      : undefined;

    const where = searchCondition ? and(...baseConditions, searchCondition) : and(...baseConditions);

    const [dataResult, countResult] = await Promise.all([
      this.db
        .select({
          id: users.id,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: organizationMembers.role,
          designation: users.designation,
          employeeId: users.employeeId,
          orgDepartmentId: orgUnits.id,
          orgDepartmentName: orgUnits.name,
          image: users.image,
          isActive: users.isActive,
          joiningDate: users.joiningDate,
          reportingTo: users.reportingTo,
          monthlySalary: users.monthlySalary,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(orgUnits, and(eq(users.orgDepartmentId, orgUnits.id), eq(orgUnits.kind, "DEPARTMENT")))
        .where(where)
        .orderBy(users.name)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(where),
    ]);

    const total = countResult[0]?.total ?? 0;

    return {
      data: dataResult.map((row) => ({
        id: row.id,
        name: row.name,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        role: row.role,
        designation: row.designation,
        employeeId: row.employeeId,
        department:
          row.orgDepartmentId != null && row.orgDepartmentName
            ? { id: row.orgDepartmentId, name: row.orgDepartmentName }
            : null,
        image: row.image,
        isActive: row.isActive,
        joiningDate: row.joiningDate,
        reportingTo: row.reportingTo,
        monthlySalary: row.monthlySalary,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getStats(orgId: string, userId: string) {
    const year = new Date().getFullYear();
    const startOfYear = `${year}-01-01`;
    const endOfYear = `${year}-12-31`;

    const leaveWhere = and(
      eq(leaveRequests.userId, userId),
      eq(leaveRequests.orgId, orgId),
      gte(leaveRequests.startDate, startOfYear),
      lte(leaveRequests.startDate, endOfYear),
    );
    const attendanceWhere = and(
      eq(attendance.userId, userId),
      eq(attendance.orgId, orgId),
      gte(attendance.date, startOfYear),
      lte(attendance.date, endOfYear),
    );

    const [[leaveAgg], byTypeRows, [attendanceAgg]] = await Promise.all([
      this.db
        .select({
          total: sql<string>`COUNT(*)`,
          approved: sql<string>`COUNT(*) FILTER (WHERE ${leaveRequests.status} = 'APPROVED')`,
          pending: sql<string>`COUNT(*) FILTER (WHERE ${leaveRequests.status} = 'PENDING')`,
          rejected: sql<string>`COUNT(*) FILTER (WHERE ${leaveRequests.status} = 'REJECTED')`,
        })
        .from(leaveRequests)
        .where(leaveWhere),
      this.db
        .select({ leaveTypeId: leaveRequests.leaveTypeId, count: sql<string>`COUNT(*)` })
        .from(leaveRequests)
        .where(leaveWhere)
        .groupBy(leaveRequests.leaveTypeId),
      this.db
        .select({
          daysPresent: sql<string>`COUNT(*) FILTER (WHERE ${attendance.checkIn} IS NOT NULL)`,
          totalHours: sql<string>`COALESCE(SUM(${attendance.workHours}) FILTER (WHERE ${attendance.checkIn} IS NOT NULL), 0)`,
        })
        .from(attendance)
        .where(attendanceWhere),
    ]);

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      const typeKey = row.leaveTypeId?.toString() ?? "unknown";
      byType[typeKey] = Number(row.count ?? 0);
    }

    const daysPresent = Number(attendanceAgg?.daysPresent ?? 0);
    const totalHours = Number(attendanceAgg?.totalHours ?? 0);

    return {
      leaves: {
        total: Number(leaveAgg?.total ?? 0),
        approved: Number(leaveAgg?.approved ?? 0),
        pending: Number(leaveAgg?.pending ?? 0),
        rejected: Number(leaveAgg?.rejected ?? 0),
        byType,
      },
      attendance:
        daysPresent > 0
          ? {
              daysPresent,
              daysAbsent: 0,
              daysLate: 0,
              totalHours: totalHours.toFixed(2),
              avgHoursPerDay: (totalHours / daysPresent).toFixed(2),
            }
          : null,
    };
  }

  async checkEmail(orgId: string, email: string) {
    const normalised = email.toLowerCase().trim();
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, normalised),
      columns: { id: true },
    });
    if (!existing) return { exists: false };
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, existing.id),
      ),
      columns: { userId: true },
    });
    return { exists: !!member };
  }

  getProjects(orgId: string, userId: string) {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projectMembers.userId, userId), eq(projects.orgId, orgId)));
  }

  async getTickets(orgId: string, userId: string) {
    const data = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        priority: tickets.priority,
        projectId: tickets.projectId,
        ticketNumber: tickets.ticketNumber,
      })
      .from(tickets)
      .where(and(eq(tickets.assigneeId, userId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
      .orderBy(desc(tickets.id))
      .limit(50);

    return { data };
  }

  async getReportsToMe(orgId: string, employeeId: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, employeeId), eq(organizationMembers.orgId, orgId)),
      columns: { userId: true },
    });
    if (!member) throw new NotFoundException("Employee not found");

    return this.db
      .select({
        id: users.id,
        name: users.name,
        image: users.image,
        designation: users.designation,
        email: users.email,
      })
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(users.reportingTo, employeeId),
          eq(users.isActive, true),
        ),
      );
  }

  async getManagerScorecard(orgId: string, employeeId: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, employeeId), eq(organizationMembers.orgId, orgId)),
      columns: { userId: true },
    });
    if (!member) throw new NotFoundException("Employee not found");

    const reports = await this.db
      .select({
        id: users.id,
        name: users.name,
        image: users.image,
        designation: users.designation,
      })
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(users.reportingTo, employeeId),
          eq(users.isActive, true),
        ),
      );

    if (reports.length === 0) {
      return {
        managerId: employeeId,
        teamSize: 0,
        avgPerformanceRating: null,
        teamAttendanceRate: null,
        pendingLeaveRequests: 0,
        directReports: [],
      };
    }

    const reportIds = reports.map((r) => r.id);

    const [ratingsResult, attendanceResult] = await Promise.all([
      this.db
        .select({ userId: performanceReviews.userId, avg: avg(performanceReviews.overallRating) })
        .from(performanceReviews)
        .where(and(eq(performanceReviews.orgId, orgId), inArray(performanceReviews.userId, reportIds)))
        .groupBy(performanceReviews.userId),
      this.db
        .select({ userId: attendance.userId, cnt: count() })
        .from(attendance)
        .where(
          and(
            eq(attendance.orgId, orgId),
            inArray(attendance.userId, reportIds),
            gte(attendance.date, formatDateOnly(subDays(new Date(), 30))),
          ),
        )
        .groupBy(attendance.userId),
    ]);

    const ratingsMap = new Map(ratingsResult.map((r) => [r.userId, r.avg]));
    const ratingsPerReport = reportIds.map((userId) => {
      const raw = ratingsMap.get(userId);
      return { userId, avg: raw ? parseFloat(String(raw)) : null };
    });

    const attendanceMap = new Map(attendanceResult.map((r) => [r.userId, r.cnt]));
    const totalPresent = reportIds.reduce((sum, id) => sum + (attendanceMap.get(id) ?? 0), 0);
    const maxPossible = reportIds.length * 30;
    const teamAttendanceRate = maxPossible > 0 ? Math.round((totalPresent / maxPossible) * 100) : null;

    const [pendingResult] = await this.db
      .select({ cnt: count() })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          eq(leaveRequests.status, "PENDING"),
          eq(leaveRequests.approverId, employeeId),
        ),
      );
    const pendingLeaveRequests = pendingResult?.cnt ?? 0;

    const ratingValues = ratingsPerReport.map((r) => r.avg).filter((v): v is number => v !== null);
    const avgPerformanceRating =
      ratingValues.length > 0
        ? Math.round((ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length) * 10) / 10
        : null;

    const directReports = reports.map((r) => ({
      ...r,
      avgRating: ratingsPerReport.find((rr) => rr.userId === r.id)?.avg ?? null,
    }));

    return {
      managerId: employeeId,
      teamSize: reports.length,
      avgPerformanceRating,
      teamAttendanceRate,
      pendingLeaveRequests,
      directReports,
    };
  }
}
