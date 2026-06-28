import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  attendance,
  candidates,
  payrolls,
  projects,
  tickets,
  timesheets,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  resolveAttendanceReportScope,
  resolvePayrollReportScope,
} from "./reports-scope";
import type {
  AttendanceReportInput,
  PayrollReportInput,
  ProjectReportInput,
  TeamPerformanceReportInput,
} from "./dto/report.schemas";

export type ReportBadRequest = { error: "bad_request"; message: string };
export type ReportForbidden = { error: "forbidden"; message: string };

export function isBadRequest(value: unknown): value is ReportBadRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "bad_request"
  );
}

export function isForbidden(value: unknown): value is ReportForbidden {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "forbidden"
  );
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async getAttendanceReport(
    orgId: string,
    actor: CurrentUserContext,
    input: AttendanceReportInput,
  ) {
    const startDate = new Date(input.startDate);
    const endDate = new Date(input.endDate);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return { error: "bad_request", message: "Invalid date format" } as ReportBadRequest;
    }

    const attendanceScope = await resolveAttendanceReportScope(this.access, actor);
    const canViewAll = attendanceScope === "all";
    if (input.userId && input.userId !== actor.userId && !canViewAll) {
      return { error: "forbidden", message: "Forbidden" } as ReportForbidden;
    }

    const targetUserId = input.userId || (canViewAll ? undefined : actor.userId);

    const records = await this.db.query.attendance.findMany({
      where: and(
        eq(attendance.orgId, orgId),
        ...(targetUserId ? [eq(attendance.userId, targetUserId)] : []),
        gte(attendance.date, formatDateOnly(startDate)),
        lte(attendance.date, formatDateOnly(endDate)),
      ),
      orderBy: [desc(attendance.date)],
    });

    const totalDays = records.length;
    const totalHours = records.reduce(
      (sum, r) => sum + parseFloat(r.workHours || "0"),
      0,
    );
    const averageHours = totalDays > 0 ? totalHours / totalDays : 0;
    const overtimeDays = records.filter((r) => r.isOvertime).length;

    return {
      records,
      summary: {
        totalDays,
        totalHours: Math.round(totalHours * 10) / 10,
        averageHours: Math.round(averageHours * 10) / 10,
        overtimeDays,
      },
    };
  }

  async getPayrollReport(
    orgId: string,
    actor: CurrentUserContext,
    input: PayrollReportInput,
  ) {
    const payrollScope = await resolvePayrollReportScope(this.access, actor);
    const canViewAll = payrollScope === "all";
    if (input.userId && input.userId !== actor.userId && !canViewAll) {
      return { error: "forbidden", message: "Forbidden" } as ReportForbidden;
    }

    const targetUserId = input.userId || (canViewAll ? undefined : actor.userId);

    const payrollsList = await this.db.query.payrolls.findMany({
      where: and(
        eq(payrolls.orgId, orgId),
        ...(targetUserId ? [eq(payrolls.userId, targetUserId)] : []),
        sql`${payrolls.month} >= ${input.startMonth}`,
        sql`${payrolls.month} <= ${input.endMonth}`,
      ),
      orderBy: [desc(payrolls.month)],
    });

    const totalGross = payrollsList.reduce(
      (sum, p) => sum + parseFloat(p.grossSalary || "0"),
      0,
    );
    const totalNet = payrollsList.reduce(
      (sum, p) => sum + parseFloat(p.netSalary || "0"),
      0,
    );
    const totalDeductions = payrollsList.reduce(
      (sum, p) => sum + parseFloat(p.deductions || "0"),
      0,
    );

    return {
      payrolls: payrollsList,
      summary: {
        count: payrollsList.length,
        totalGross: Math.round(totalGross * 10) / 10,
        totalNet: Math.round(totalNet * 10) / 10,
        totalDeductions: Math.round(totalDeductions * 10) / 10,
      },
    };
  }

  async getProjectReport(orgId: string, input: ProjectReportInput) {
    const conditions = [eq(projects.orgId, orgId)];
    if (input.projectId) {
      conditions.push(eq(projects.id, input.projectId));
    }

    const projectsList = await this.db.query.projects.findMany({
      where: and(...conditions),
      with: {
        tickets: {
          with: {
            assignee: true,
          },
        },
      },
    });

    const projectStats = projectsList.map((project) => {
      const projectTickets = project.tickets || [];
      const totalTickets = projectTickets.length;
      const completedTickets = projectTickets.filter(
        (t) => t.status === "DONE",
      ).length;
      const inProgressTickets = projectTickets.filter(
        (t) => t.status === "IN_PROGRESS",
      ).length;
      const totalPoints = projectTickets.reduce(
        (sum, t) => sum + (t.points || 0),
        0,
      );
      const completedPoints = projectTickets
        .filter((t) => t.status === "DONE")
        .reduce((sum, t) => sum + (t.points || 0), 0);

      return {
        projectId: project.id,
        projectName: project.name,
        totalTickets,
        completedTickets,
        inProgressTickets,
        totalPoints,
        completedPoints,
        completionRate:
          totalTickets > 0 ? (completedTickets / totalTickets) * 100 : 0,
        pointsCompletionRate:
          totalPoints > 0 ? (completedPoints / totalPoints) * 100 : 0,
      };
    });

    return {
      projects: projectStats,
      summary: {
        totalProjects: projectsList.length,
        activeProjects: projectsList.filter((p) => p.status === "ACTIVE").length,
        totalTickets: projectStats.reduce((sum, p) => sum + p.totalTickets, 0),
        completedTickets: projectStats.reduce(
          (sum, p) => sum + p.completedTickets,
          0,
        ),
      },
    };
  }

  async getTeamPerformanceReport(
    orgId: string,
    input: TeamPerformanceReportInput,
  ) {
    const startDate = new Date(input.startDate);
    const endDate = new Date(input.endDate);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return { error: "bad_request", message: "Invalid date format" } as ReportBadRequest;
    }

    const timeEntries = await this.db.query.timesheets.findMany({
      where: and(
        eq(timesheets.orgId, orgId),
        gte(timesheets.date, formatDateOnly(startDate)),
        lte(timesheets.date, formatDateOnly(endDate)),
      ),
      with: {
        ticket: {
          with: {
            assignee: true,
          },
        },
      },
    });

    const userStats = new Map<
      string,
      {
        userId: string;
        userName: string;
        totalHours: number;
        ticketsWorked: Set<number>;
        ticketsCompleted: number;
      }
    >();

    timeEntries.forEach((entry) => {
      if (!entry.userId || !entry.ticket || !entry.ticketId) return;

      const existing = userStats.get(entry.userId);
      const hours = parseFloat(entry.hours || "0");

      if (existing) {
        existing.totalHours += hours;
        if (!existing.ticketsWorked) {
          existing.ticketsWorked = new Set<number>();
        }
        existing.ticketsWorked.add(entry.ticketId);
      } else {
        userStats.set(entry.userId, {
          userId: entry.userId,
          userName: entry.ticket?.assignee?.firstName || "Unknown",
          totalHours: hours,
          ticketsWorked: new Set([entry.ticketId]),
          ticketsCompleted: 0,
        });
      }
    });

    const completedTickets = await this.db.query.tickets.findMany({
      where: and(
        eq(tickets.orgId, orgId),
        eq(tickets.status, "DONE"),
        gte(tickets.updatedAt, startDate),
        lte(tickets.updatedAt, endDate),
      ),
    });

    completedTickets.forEach((ticket) => {
      if (ticket.assigneeId) {
        const stats = userStats.get(ticket.assigneeId);
        if (stats) {
          stats.ticketsCompleted += 1;
        }
      }
    });

    return Array.from(userStats.values()).map((stats) => ({
      ...stats,
      ticketsWorked: stats.ticketsWorked.size || 0,
    }));
  }

  getSourceEffectiveness(orgId: string) {
    return this.cache.cached(
      `reports:source-effectiveness:${orgId}`,
      async () => {
        const rows = await this.db
          .select({
            source: sql<string>`COALESCE(${candidates.source}, 'DIRECT')`,
            total: sql<number>`COUNT(*)::int`,
            hired: sql<number>`COUNT(*) FILTER (WHERE ${candidates.status} = 'HIRED')::int`,
            rejected: sql<number>`COUNT(*) FILTER (WHERE ${candidates.status} = 'REJECTED')::int`,
          })
          .from(candidates)
          .where(eq(candidates.orgId, orgId))
          .groupBy(sql`COALESCE(${candidates.source}, 'DIRECT')`)
          .orderBy(sql`COUNT(*) DESC`);

        return rows.map((r) => ({
          source: r.source,
          total: r.total,
          hired: r.hired,
          rejected: r.rejected,
          hireRate: r.total > 0 ? Math.round((r.hired / r.total) * 100) : 0,
        }));
      },
      CACHE_TTL.MEDIUM,
    );
  }
}
