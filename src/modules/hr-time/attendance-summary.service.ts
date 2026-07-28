import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { attendance, employeeShiftAssignments, hrAttendanceRegularizations, orgHolidays, organizationMembers, rosterEntries, rosters, shiftTemplates, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AttendancePolicyService } from "./attendance-policy.service";

interface ShiftInfo {
  startTime: string;
  endTime: string;
  breakMinutes: number;
  gracePeriodMinutes: number;
}

export interface EmployeeAttendanceSummary {
  userId: string;
  userName: string;
  payableDays: number;
  presentDays: number;
  absentDays: number;
  lateCount: number;
  latePenaltyDays: number;
  earlyExitCount: number;
  approvedRegularizations: number;
  overtimeMinutes: number;
  weekendWorkDays: number;
  holidayWorkDays: number;
}

export interface BuildAttendanceSummaryParams {
  orgId: string;
  periodStart: string;
  periodEnd: string;
  employeeId?: string;
  userIds?: string[];
  page?: number;
  limit?: number;
}

@Injectable()
export class AttendanceSummaryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly policyService: AttendancePolicyService,
  ) {}

  async buildAttendanceSummary(params: BuildAttendanceSummaryParams) {
    const { orgId, periodStart, periodEnd, employeeId, userIds: explicitUserIds } = params;

    let members: { userId: string; name: string | null; firstName: string | null; lastName: string | null; email: string }[];
    let responseLimit: number;

    if (explicitUserIds !== undefined) {
      if (explicitUserIds.length === 0) return { data: [], page: 1, limit: 0 };
      members = await this.db
        .select({ userId: organizationMembers.userId, name: users.name, firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true), inArray(organizationMembers.userId, explicitUserIds)));
      responseLimit = members.length;
    } else {
      const pageSize = Math.min(params.limit ?? 50, 100);
      const offset = ((params.page ?? 1) - 1) * pageSize;

      const memberConditions = [eq(organizationMembers.orgId, orgId), eq(users.isActive, true)];
      if (employeeId) memberConditions.push(eq(organizationMembers.userId, employeeId));

      members = await this.db
        .select({ userId: organizationMembers.userId, name: users.name, firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(...memberConditions))
        .limit(pageSize)
        .offset(offset);

      if (members.length === 0) return { data: [], page: params.page ?? 1, limit: pageSize };
      responseLimit = pageSize;
    }

    const userIds = members.map((m) => m.userId);

    const [attendanceRows, regularizationRows, holidayRows] = await Promise.all([
      this.db
        .select({
          userId: attendance.userId,
          date: attendance.date,
          checkIn: attendance.checkIn,
          checkOut: attendance.checkOut,
          workHours: attendance.workHours,
          isOvertime: attendance.isOvertime,
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.orgId, orgId),
            inArray(attendance.userId, userIds),
            gte(attendance.date, periodStart),
            lte(attendance.date, periodEnd),
            isNotNull(attendance.checkIn),
          ),
        ),

      this.db
        .select({
          userId: hrAttendanceRegularizations.userId,
          attendanceDate: hrAttendanceRegularizations.attendanceDate,
          requestedCheckIn: hrAttendanceRegularizations.requestedCheckIn,
          requestedCheckOut: hrAttendanceRegularizations.requestedCheckOut,
        })
        .from(hrAttendanceRegularizations)
        .where(
          and(
            eq(hrAttendanceRegularizations.orgId, orgId),
            inArray(hrAttendanceRegularizations.userId, userIds),
            eq(hrAttendanceRegularizations.status, "APPROVED"),
            gte(hrAttendanceRegularizations.attendanceDate, periodStart),
            lte(hrAttendanceRegularizations.attendanceDate, periodEnd),
          ),
        ),

      this.db
        .select({ date: orgHolidays.date })
        .from(orgHolidays)
        .where(and(eq(orgHolidays.orgId, orgId), gte(orgHolidays.date, periodStart), lte(orgHolidays.date, periodEnd))),
    ]);

    const holidaySet = new Set(holidayRows.map((h) => h.date));

    const workingDaysInPeriod = this.countWorkingDays(periodStart, periodEnd, holidaySet);

    const attendanceByUser = new Map<string, (typeof attendanceRows)>();
    for (const row of attendanceRows) {
      const existing = attendanceByUser.get(row.userId) ?? [];
      existing.push(row);
      attendanceByUser.set(row.userId, existing);
    }

    const regularizationsByUser = new Map<string, number>();
    for (const reg of regularizationRows) {
      regularizationsByUser.set(reg.userId, (regularizationsByUser.get(reg.userId) ?? 0) + 1);
    }

    const [rosterRows, shiftAssignmentRows] = await Promise.all([
      this.db
        .select({
          userId: rosterEntries.userId,
          startTime: shiftTemplates.startTime,
          endTime: shiftTemplates.endTime,
          breakMinutes: shiftTemplates.breakMinutes,
          gracePeriodMinutes: shiftTemplates.gracePeriodMinutes,
        })
        .from(rosterEntries)
        .innerJoin(rosters, and(eq(rosters.id, rosterEntries.rosterId), eq(rosters.orgId, orgId)))
        .innerJoin(shiftTemplates, eq(shiftTemplates.id, rosterEntries.shiftId))
        .where(and(inArray(rosterEntries.userId, userIds), eq(rosterEntries.date, periodStart))),

      this.db
        .select({
          userId: employeeShiftAssignments.userId,
          startTime: shiftTemplates.startTime,
          endTime: shiftTemplates.endTime,
          breakMinutes: shiftTemplates.breakMinutes,
          gracePeriodMinutes: shiftTemplates.gracePeriodMinutes,
        })
        .from(employeeShiftAssignments)
        .innerJoin(shiftTemplates, eq(shiftTemplates.id, employeeShiftAssignments.shiftId))
        .where(
          and(
            inArray(employeeShiftAssignments.userId, userIds),
            eq(employeeShiftAssignments.orgId, orgId),
            eq(employeeShiftAssignments.isActive, true),
            lte(employeeShiftAssignments.effectiveFrom, periodStart),
            or(isNull(employeeShiftAssignments.effectiveTo), gte(employeeShiftAssignments.effectiveTo, periodStart)),
          ),
        ),
    ]);

    const rosterShiftByUser = new Map<string, ShiftInfo>();
    for (const r of rosterRows) {
      if (!rosterShiftByUser.has(r.userId)) rosterShiftByUser.set(r.userId, r);
    }
    const assignedShiftByUser = new Map<string, ShiftInfo>();
    for (const r of shiftAssignmentRows) {
      if (!assignedShiftByUser.has(r.userId)) assignedShiftByUser.set(r.userId, r);
    }

    const representativeUserId = userIds[0] ?? "";
    const [orgAttendanceRules, orgOvertimeRules] = representativeUserId
      ? await Promise.all([
          this.policyService.getAttendanceRules(orgId, representativeUserId, periodStart),
          this.policyService.getOvertimeRules(orgId, representativeUserId, periodStart),
        ])
      : [
          { graceMinutes: 15, autoCheckoutTime: "19:00", lateArrivalPenalty: "none", halfDayThresholdMinutes: 240, absentThresholdMinutes: 0, enforceGeofence: false, minReclockInMinutes: 2 },
          { dailyThresholdMinutes: 480 },
        ] as const;

    const results: EmployeeAttendanceSummary[] = members.map((member) => {
        const userId = member.userId;
        const rows = attendanceByUser.get(userId) ?? [];

        const shiftDef = rosterShiftByUser.get(userId) ?? assignedShiftByUser.get(userId) ?? null;

        const shiftInfo = shiftDef
          ? { shiftStartMinutes: (() => { const [h, m] = shiftDef.startTime.split(":"); return Number(h) * 60 + Number(m); })(), graceMinutes: shiftDef.gracePeriodMinutes }
          : { shiftStartMinutes: 9 * 60, graceMinutes: orgAttendanceRules.graceMinutes };

        const shiftEndMinutes = shiftDef
          ? (() => {
              const [h, m] = shiftDef.endTime.split(":");
              return Number(h) * 60 + Number(m);
            })()
          : 18 * 60;

        const uniqueDates = new Set(rows.map((r) => r.date));
        const presentDays = uniqueDates.size;

        let lateCount = 0;
        let earlyExitCount = 0;
        let overtimeMinutes = 0;
        let weekendWorkDays = 0;
        let holidayWorkDays = 0;

        for (const row of rows) {
          if (row.checkIn) {
            const ci = new Date(row.checkIn);
            const ciMinutes = ci.getUTCHours() * 60 + ci.getUTCMinutes();
            if (ciMinutes > shiftInfo.shiftStartMinutes + shiftInfo.graceMinutes) lateCount++;
          }

          if (row.checkOut) {
            const co = new Date(row.checkOut);
            const coMinutes = co.getUTCHours() * 60 + co.getUTCMinutes();
            if (coMinutes < shiftEndMinutes - 15) earlyExitCount++;
          }

          if (row.isOvertime) {
            const wh = Number(row.workHours ?? 0);
            const thresholdHours = orgOvertimeRules.dailyThresholdMinutes / 60;
            if (wh > thresholdHours) {
              overtimeMinutes += Math.round((wh - thresholdHours) * 60);
            }
          }

          const dateObj = new Date(row.date + "T00:00:00Z");
          const dow = dateObj.getUTCDay();
          if (dow === 0 || dow === 6) weekendWorkDays++;
          if (holidaySet.has(row.date)) holidayWorkDays++;
        }

        const latePenaltyDays = this.calculateLatePenaltyDays(lateCount, orgAttendanceRules.lateArrivalPenalty, presentDays);
        const absentDays = Math.max(0, workingDaysInPeriod - presentDays);
        const payableDays = Math.max(0, presentDays - latePenaltyDays);
        const approvedRegularizations = regularizationsByUser.get(userId) ?? 0;

        const displayName =
          member.name ||
          [member.firstName, member.lastName].filter(Boolean).join(" ") ||
          member.email;

        return {
          userId,
          userName: displayName,
          payableDays,
          presentDays,
          absentDays,
          lateCount,
          latePenaltyDays,
          earlyExitCount,
          approvedRegularizations,
          overtimeMinutes,
          weekendWorkDays,
          holidayWorkDays,
        };
      });

    return { data: results, page: params.page ?? 1, limit: responseLimit };
  }

  private countWorkingDays(start: string, end: string, holidays: Set<string>): number {
    let count = 0;
    const current = new Date(start + "T00:00:00Z");
    const endDate = new Date(end + "T00:00:00Z");
    while (current <= endDate) {
      const dow = current.getUTCDay();
      const dateStr = current.toISOString().slice(0, 10);
      if (dow !== 0 && dow !== 6 && !holidays.has(dateStr)) count++;
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return count;
  }

  private calculateLatePenaltyDays(lateCount: number, penalty: string, _presentDays: number): number {
    if (penalty === "half_day") return lateCount * 0.5;
    if (penalty === "full_day") return lateCount;
    return 0;
  }
}
