import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, avg, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  attendance,
  leaveRequests,
  organizationMembers,
  performanceReviews,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { formatDateOnly, subDays } from "../../../common/date";
import { EmploymentFactsService } from "../../directory/employment-facts.service";

const SCORECARD_WINDOW_DAYS = 30;

@Injectable()
export class EmployeeAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employment: EmploymentFactsService,
  ) {}

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
        .groupBy(leaveRequests.leaveTypeId)
        .limit(100),
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

  async getManagerScorecard(orgId: string, employeeId: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, employeeId), eq(organizationMembers.orgId, orgId)),
      columns: { userId: true },
    });
    if (!member) throw new NotFoundException("Employee not found");

    const directReportIds = await this.employment.getDirectReportUserIds(orgId, employeeId);
    const reports =
      directReportIds.length > 0
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
            .limit(500)
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
        .where(
          and(eq(performanceReviews.orgId, orgId), inArray(performanceReviews.userId, reportIds)),
        )
        .groupBy(performanceReviews.userId),
      this.db
        .select({ userId: attendance.userId, cnt: count() })
        .from(attendance)
        .where(
          and(
            eq(attendance.orgId, orgId),
            inArray(attendance.userId, reportIds),
            gte(attendance.date, formatDateOnly(subDays(new Date(), SCORECARD_WINDOW_DAYS))),
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
    const maxPossible = reportIds.length * SCORECARD_WINDOW_DAYS;
    const teamAttendanceRate =
      maxPossible > 0 ? Math.round((totalPresent / maxPossible) * 100) : null;

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
