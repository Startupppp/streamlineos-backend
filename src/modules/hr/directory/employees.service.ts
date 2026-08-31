import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  SQL,
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  attendance,
  hrEmployments,
  hrPeople,
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
import {
  decodeEmployeeListCursor,
  encodeEmployeeListCursor,
} from "./employee-list-cursor";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../../directory/employment-query";

@Injectable()
export class EmployeesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly employment: EmploymentFactsService,
  ) {}

  listEmployees(
    orgId: string,
    userId: string,
    opts: {
      cursor?: string;
      limit?: number;
      search?: string;
      departmentId?: string;
      isActive?: "true" | "false" | "all";
      role?: string;
    },
    scope: DataScope,
  ) {
    const search = opts.search;
    const limitN = opts.limit ?? 20;
    const isActive = opts.isActive ?? "true";
    const departmentId = opts.departmentId;
    const role = opts.role?.trim() || undefined;

    const key = `hr:employees:cursor:${orgId}:${userId}:${scope}:${opts.cursor ?? ""}:${limitN}:${search ?? ""}:${departmentId ?? ""}:${isActive}:${role ?? ""}`;
    return this.cache.cached(
      key,
      () =>
        this.getEmployeesPaginated(
          orgId,
          opts.cursor,
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

  async assertEmployeeVisible(
    orgId: string,
    actorUserId: string,
    targetUserId: string,
    scope: DataScope,
  ): Promise<void> {
    const [visible] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, targetUserId),
          applyScope(scope, orgId, actorUserId, {
            ownerColumn: organizationMembers.userId,
          }),
        ),
      )
      .limit(1);

    if (!visible) throw new NotFoundException("Employee not found");
  }

  private async getEmployeesPaginated(
    orgId: string,
    encodedCursor: string | undefined,
    limit: number,
    search: string | undefined,
    userId: string,
    scope: DataScope,
    departmentId?: string,
    isActive: "true" | "false" | "all" = "true",
    role?: string,
  ) {
    const cursor = encodedCursor ? decodeEmployeeListCursor(encodedCursor) : undefined;
    const normalizedName = sql<string>`lower(coalesce(${users.name}, ''))`;

    const baseConditions: SQL[] = [
      eq(organizationMembers.orgId, orgId),
      applyScope(scope, orgId, userId, { ownerColumn: organizationMembers.userId }),
    ];
    if (isActive === "true") baseConditions.push(eq(users.isActive, true));
    else if (isActive === "false") baseConditions.push(eq(users.isActive, false));
    if (departmentId != null) baseConditions.push(eq(hrEmployments.departmentId, departmentId));
    if (role) baseConditions.push(eq(organizationMembers.role, role));
    if (cursor) {
      baseConditions.push(
        or(
          gt(normalizedName, cursor.name),
          and(
            eq(normalizedName, cursor.name),
            gt(users.id, cursor.employeeUserId),
          ),
        )!,
      );
    }

    const searchCondition = search ? await this.employeeSearchCondition(search) : undefined;

    const where = searchCondition ? and(...baseConditions, searchCondition) : and(...baseConditions);

    const dataResult = await this.db
      .select({
          id: users.id,
          cursorName: normalizedName,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: organizationMembers.role,
          orgDepartmentId: orgUnits.id,
          orgDepartmentName: orgUnits.name,
          image: users.image,
          isActive: users.isActive,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .leftJoin(
        orgUnits,
        and(
          eq(hrEmployments.departmentId, orgUnits.id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "DEPARTMENT"),
        ),
      )
      .where(where)
      .orderBy(asc(normalizedName), asc(users.id))
      .limit(limit + 1);

    const hasMore = dataResult.length > limit;
    const pageRows = dataResult.slice(0, limit);
    const lastRow = pageRows.at(-1);
    const factsMap = await this.employment.getFactsBatch(orgId, pageRows.map((r) => r.id));

    return {
      data: pageRows.map((row) => {
        const facts = factsMap.get(row.id);
        return {
          id: row.id,
          name: row.name,
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          role: row.role,
          designation: facts?.designation ?? null,
          employeeId: facts?.employeeNumber ?? null,
          department:
            row.orgDepartmentId != null && row.orgDepartmentName
              ? { id: row.orgDepartmentId, name: row.orgDepartmentName }
              : null,
          image: row.image,
          isActive: row.isActive,
          joiningDate: facts?.joiningDate ?? null,
          reportingTo: facts?.managerUserId ?? null,
        };
      }),
      pageInfo: {
        limit,
        hasMore,
        nextCursor:
          hasMore && lastRow
            ? encodeEmployeeListCursor({
                name: lastRow.cursorName,
                employeeUserId: lastRow.id,
              })
            : null,
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

    const reportIds = await this.employment.getDirectReportUserIds(orgId, employeeId);
    if (reportIds.length === 0) return [];

    const rows = await this.db
      .select({
        id: users.id,
        name: users.name,
        image: users.image,
        email: users.email,
      })
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          inArray(users.id, reportIds),
          eq(users.isActive, true),
        ),
      );

    const factsMap = await this.employment.getFactsBatch(orgId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, designation: factsMap.get(r.id)?.designation ?? null }));
  }

  private static readonly EMPLOYEE_SEARCH_CAP = 500;

  private async employeeSearchCondition(search: string): Promise<SQL> {
    const employmentIlike = or(
      ilike(hrEmployments.employeeNumber, `%${search}%`),
      ilike(hrEmployments.designation, `%${search}%`),
    )!;
    const rows = await this.db.execute(
      sql`SELECT app.search_hr_person_ids(${search}, ${EmployeesService.EMPLOYEE_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return employmentIlike;
    if (rows.length > EmployeesService.EMPLOYEE_SEARCH_CAP)
      return or(
        ilike(users.name, `%${search}%`),
        ilike(users.email, `%${search}%`),
        ilike(users.firstName, `%${search}%`),
        ilike(users.lastName, `%${search}%`),
        employmentIlike,
      )!;
    const ids = rows.map((r) => Number(r["id"]));
    return or(inArray(hrPeople.id, ids), employmentIlike)!;
  }

  async getManagerScorecard(orgId: string, employeeId: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, employeeId), eq(organizationMembers.orgId, orgId)),
      columns: { userId: true },
    });
    if (!member) throw new NotFoundException("Employee not found");

    const directReportIds = await this.employment.getDirectReportUserIds(orgId, employeeId);
    const reports = directReportIds.length > 0
      ? await this.db
          .select({
            id: users.id,
            name: users.name,
            image: users.image,
          })
          .from(users)
          .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              inArray(users.id, directReportIds),
              eq(users.isActive, true),
            ),
          )
      : [];

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
    const reportFactsMap = await this.employment.getFactsBatch(orgId, reportIds);

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
      designation: reportFactsMap.get(r.id)?.designation ?? null,
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
