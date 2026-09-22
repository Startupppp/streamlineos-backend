import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte, notInArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { organizationMembers, timesheetExports, timesheetPeriods, timesheets, users } from "../../../db/schema";

export const READINESS_EXPORT_CAP = 10;
export const READINESS_DRIFT_CAP = 100;

const PAYABLE_PERIOD_STATUSES = ["APPROVED", "LOCKED"] as const;

export interface TimesheetReadinessWindow {
  start: string;
  end: string;
}

export interface TimesheetReadinessExport {
  id: number;
  createdAt: Date;
  dateRangeStart: string;
  dateRangeEnd: string;
  entryCount: number;
  totalHours: string;
  workerCount: number;
  ackStatus: string | null;
  ackAt: Date | null;
  ackNote: string | null;
}

export interface TimesheetReadinessDrift {
  periodId: number;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  exportId: number;
  exportedEntryCount: number;
  exportedHours: string;
  updatedAt: Date;
}

export interface TimesheetReadinessFacts {
  window: TimesheetReadinessWindow;
  periods: { unsubmitted: number; awaitingApproval: number; approved: number; locked: number; rejected: number };
  exports: TimesheetReadinessExport[];
  approvedNotExported: { entryCount: number; hours: string };
  drift: TimesheetReadinessDrift[];
}

@Injectable()
export class TimesheetPayrollReadinessFactsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async facts(orgId: string, window: TimesheetReadinessWindow): Promise<TimesheetReadinessFacts> {
    const overlapping = and(
      eq(timesheetPeriods.orgId, orgId),
      lte(timesheetPeriods.periodStart, window.end),
      gte(timesheetPeriods.periodEnd, window.start),
    );
    const [statusRows, exportRows, approvedRows, driftRows] = await Promise.all([
      this.db
        .select({ status: timesheetPeriods.status, total: sql<number>`count(*)::int` })
        .from(timesheetPeriods)
        .where(overlapping)
        .groupBy(timesheetPeriods.status),
      this.db
        .select({
          id: timesheetExports.id,
          createdAt: timesheetExports.createdAt,
          dateRangeStart: timesheetExports.dateRangeStart,
          dateRangeEnd: timesheetExports.dateRangeEnd,
          entryCount: timesheetExports.entryCount,
          totalHours: timesheetExports.totalHours,
          workerCount: sql<number>`jsonb_array_length(${timesheetExports.snapshot})::int`,
          ackStatus: timesheetExports.ackStatus,
          ackAt: timesheetExports.ackAt,
          ackNote: timesheetExports.ackNote,
        })
        .from(timesheetExports)
        .where(
          and(
            eq(timesheetExports.orgId, orgId),
            eq(timesheetExports.exportType, "PAYROLL"),
            eq(timesheetExports.status, "COMPLETED"),
            lte(timesheetExports.dateRangeStart, window.end),
            gte(timesheetExports.dateRangeEnd, window.start),
          ),
        )
        .orderBy(desc(timesheetExports.createdAt), desc(timesheetExports.id))
        .limit(READINESS_EXPORT_CAP),
      this.db
        .select({
          entryCount: sql<number>`count(*)::int`,
          hours: sql<string>`coalesce(sum(${timesheets.hours}), 0)::text`,
        })
        .from(timesheets)
        .where(
          and(
            eq(timesheets.orgId, orgId),
            eq(timesheets.status, "APPROVED"),
            eq(timesheets.payrollStatus, "UNPROCESSED"),
            isNull(timesheets.voidedAt),
            gte(timesheets.date, window.start),
            lte(timesheets.date, window.end),
          ),
        ),
      this.db
        .select({
          periodId: timesheetPeriods.id,
          userId: organizationMembers.userId,
          userName: users.name,
          userEmail: users.email,
          periodStart: timesheetPeriods.periodStart,
          periodEnd: timesheetPeriods.periodEnd,
          status: timesheetPeriods.status,
          exportId: timesheets.payrollExportId,
          exportedEntryCount: sql<number>`count(${timesheets.id})::int`,
          exportedHours: sql<string>`coalesce(sum(${timesheets.hours}), 0)::text`,
          updatedAt: timesheetPeriods.updatedAt,
        })
        .from(timesheetPeriods)
        .innerJoin(
          timesheets,
          and(
            eq(timesheets.timesheetPeriodId, timesheetPeriods.id),
            eq(timesheets.orgId, timesheetPeriods.orgId),
            eq(timesheets.payrollStatus, "EXPORTED"),
          ),
        )
        .leftJoin(
          organizationMembers,
          and(eq(organizationMembers.id, timesheetPeriods.userMembershipId), eq(organizationMembers.orgId, timesheetPeriods.orgId)),
        )
        .leftJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(overlapping, notInArray(timesheetPeriods.status, [...PAYABLE_PERIOD_STATUSES])))
        .groupBy(
          timesheetPeriods.id,
          organizationMembers.userId,
          users.name,
          users.email,
          timesheetPeriods.periodStart,
          timesheetPeriods.periodEnd,
          timesheetPeriods.status,
          timesheets.payrollExportId,
          timesheetPeriods.updatedAt,
        )
        .orderBy(desc(timesheetPeriods.updatedAt))
        .limit(READINESS_DRIFT_CAP),
    ]);

    const byStatus = new Map(statusRows.map((row) => [row.status, row.total]));
    const unsubmitted = (byStatus.get("OPEN") ?? 0) + (byStatus.get("DRAFT") ?? 0);
    const approved = approvedRows[0] ?? { entryCount: 0, hours: "0" };

    return {
      window,
      periods: {
        unsubmitted,
        awaitingApproval: byStatus.get("SUBMITTED") ?? 0,
        approved: byStatus.get("APPROVED") ?? 0,
        locked: byStatus.get("LOCKED") ?? 0,
        rejected: byStatus.get("REJECTED") ?? 0,
      },
      exports: exportRows,
      approvedNotExported: { entryCount: approved.entryCount, hours: approved.hours },
      drift: driftRows.flatMap((row) => (row.exportId === null ? [] : [{ ...row, exportId: row.exportId }])),
    };
  }
}
