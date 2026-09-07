import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { toWallClockUtc } from "../../../common/date/zoned-wall-clock";
import { attendance, employeeShiftAssignments, hrAttendanceRegularizations, organizationMembers, organizations, rosterEntries, rosters, shiftTemplates, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { listCompatibleHolidays } from "../../../db/compat/organization-holidays";
import { AttendancePolicyService } from "./attendance-policy.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { attendanceMemberScope, resolveAttendanceReadScope } from "./attendance-scope";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { requireOrganizationMembershipId } from "./organization-membership";

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
  cursor?: string;
  limit?: number;
}

function decodeMemberCursor(value: string | undefined) {
  if (value === undefined) return null;
  const position = decodeCursor(value);
  if (!position) throw new BadRequestException("Invalid pagination cursor");

  try {
    const name: unknown = JSON.parse(position.sortValue);
    if (name !== null && typeof name !== "string") throw new Error();
    return { name, userId: position.id };
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }
}

export type BuildScopedAttendanceSummaryParams = Omit<
  BuildAttendanceSummaryParams,
  "orgId" | "userIds"
>;

interface AttendanceSummaryScope {
  actorMembershipId: number;
  dataScope: Awaited<ReturnType<typeof resolveAttendanceReadScope>>;
}

const ATTENDANCE_READ_BATCH_SIZE = 500;
const MEMBER_READ_BATCH_SIZE = 100;

async function readKeysetBatches<T>(input: {
  fetch: (afterId: number | null, limit: number) => Promise<T[]>;
  getId: (row: T) => number;
}) {
  const rows: T[] = [];
  let afterId: number | null = null;
  while (true) {
    const batch = await input.fetch(afterId, ATTENDANCE_READ_BATCH_SIZE);
    rows.push(...batch);
    if (batch.length < ATTENDANCE_READ_BATCH_SIZE) return rows;
    afterId = input.getId(batch[batch.length - 1]);
  }
}

@Injectable()
export class AttendanceSummaryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly policyService: AttendancePolicyService,
    private readonly access: AccessService,
  ) {}

  async buildScopedAttendanceSummary(
    currentUser: CurrentUserContext,
    params: BuildScopedAttendanceSummaryParams,
  ) {
    const dataScope = await resolveAttendanceReadScope(this.access, currentUser);
    const actorMembershipId = await requireOrganizationMembershipId(
      this.db,
      currentUser.orgId,
      currentUser.userId,
    );
    return this.build({ ...params, orgId: currentUser.orgId }, { actorMembershipId, dataScope });
  }

  buildAttendanceSummary(params: BuildAttendanceSummaryParams) {
    return this.build(params);
  }

  private async build(params: BuildAttendanceSummaryParams, scope?: AttendanceSummaryScope) {
    const { orgId, periodStart, periodEnd, employeeId, userIds: explicitUserIds } = params;

    let members: { membershipId: number; userId: string; name: string | null; firstName: string | null; lastName: string | null; email: string }[];
    let pagination: {
      limit: number;
      nextCursor: string | null;
      hasMore: boolean;
    };

    if (explicitUserIds !== undefined) {
      if (explicitUserIds.length === 0) {
        return {
          data: [],
          pagination: { limit: 0, nextCursor: null, hasMore: false },
        };
      }
      members = [];
      for (let offset = 0; offset < explicitUserIds.length; offset += MEMBER_READ_BATCH_SIZE) {
        const userIdBatch = explicitUserIds.slice(offset, offset + MEMBER_READ_BATCH_SIZE);
        const memberBatch = await this.db
          .select({ membershipId: organizationMembers.id, userId: organizationMembers.userId, name: users.name, firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              eq(organizationMembers.status, "ACTIVE"),
              eq(users.isActive, true),
              inArray(organizationMembers.userId, userIdBatch),
            ),
          )
          .limit(userIdBatch.length);
        members.push(...memberBatch);
      }
      pagination = {
        limit: members.length,
        nextCursor: null,
        hasMore: false,
      };
    } else {
      const pageSize = Math.min(params.limit ?? 50, 100);

      const memberConditions = [
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        eq(users.isActive, true),
      ];
      if (employeeId) memberConditions.push(eq(organizationMembers.userId, employeeId));
      if (scope) {
        memberConditions.push(attendanceMemberScope(scope.dataScope, scope.actorMembershipId, organizationMembers.id));
      }
      const cursorPosition = decodeMemberCursor(params.cursor);
      if (cursorPosition) {
        const cursorCondition = cursorPosition.name === null
          ? and(
              isNull(users.name),
              gt(organizationMembers.userId, cursorPosition.userId),
            )
          : or(
              gt(users.name, cursorPosition.name),
              isNull(users.name),
              and(
                eq(users.name, cursorPosition.name),
                gt(organizationMembers.userId, cursorPosition.userId),
              ),
            );
        if (cursorCondition) memberConditions.push(cursorCondition);
      }

      const memberRows = await this.db
        .select({ membershipId: organizationMembers.id, userId: organizationMembers.userId, name: users.name, firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(...memberConditions))
        .orderBy(asc(users.name), asc(organizationMembers.userId))
        .limit(pageSize + 1);

      const page = buildCursorPage(memberRows, pageSize, (member) => ({
        sortValue: JSON.stringify(member.name),
        id: member.userId,
      }));
      members = page.data;
      pagination = page.pagination;
      if (members.length === 0) return { data: [], pagination };
    }

    const userIds = members.map((m) => m.userId);
    const membershipIds = members.map((m) => m.membershipId);
    const userIdByMembershipId = new Map(members.map((member) => [member.membershipId, member.userId]));

    const [orgRow, attendanceRows, regularizationRows, holidayRows] = await Promise.all([
      this.db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
      readKeysetBatches({
        fetch: (afterId, batchSize) => this.db
          .select({
            id: attendance.id,
            membershipId: attendance.userMembershipId,
            date: attendance.date,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            workHours: attendance.workHours,
            isOvertime: attendance.isOvertime,
          })
          .from(attendance)
          .where(and(
            eq(attendance.orgId, orgId),
            inArray(attendance.userMembershipId, membershipIds),
            gte(attendance.date, periodStart),
            lte(attendance.date, periodEnd),
            isNotNull(attendance.checkIn),
            ...(afterId === null ? [] : [gt(attendance.id, afterId)]),
          ))
          .orderBy(asc(attendance.id))
          .limit(batchSize),
        getId: (row) => row.id,
      }),

      readKeysetBatches({
        fetch: (afterId, batchSize) => this.db
          .select({
            id: hrAttendanceRegularizations.id,
            membershipId: hrAttendanceRegularizations.userMembershipId,
            attendanceDate: hrAttendanceRegularizations.attendanceDate,
            requestedCheckIn: hrAttendanceRegularizations.requestedCheckIn,
            requestedCheckOut: hrAttendanceRegularizations.requestedCheckOut,
          })
          .from(hrAttendanceRegularizations)
          .where(and(
            eq(hrAttendanceRegularizations.orgId, orgId),
            inArray(hrAttendanceRegularizations.userMembershipId, membershipIds),
            eq(hrAttendanceRegularizations.status, "APPROVED"),
            gte(hrAttendanceRegularizations.attendanceDate, periodStart),
            lte(hrAttendanceRegularizations.attendanceDate, periodEnd),
            ...(afterId === null ? [] : [gt(hrAttendanceRegularizations.id, afterId)]),
          ))
          .orderBy(asc(hrAttendanceRegularizations.id))
          .limit(batchSize),
        getId: (row) => row.id,
      }),

      listCompatibleHolidays(this.db, orgId, periodStart, periodEnd),
    ]);

    const orgTimezone = orgRow[0]?.timezone ?? "Asia/Kolkata";

    const holidaySet = new Set(holidayRows.map((h) => h.date));

    const workingDaysInPeriod = this.countWorkingDays(periodStart, periodEnd, holidaySet);

    const attendanceByUser = new Map<string, (typeof attendanceRows)>();
    for (const row of attendanceRows) {
      if (row.membershipId === null) continue;
      const userId = userIdByMembershipId.get(row.membershipId);
      if (!userId) continue;
      const existing = attendanceByUser.get(userId) ?? [];
      existing.push(row);
      attendanceByUser.set(userId, existing);
    }

    const regularizationsByUser = new Map<string, number>();
    for (const reg of regularizationRows) {
      if (reg.membershipId === null) continue;
      const userId = userIdByMembershipId.get(reg.membershipId);
      if (!userId) continue;
      regularizationsByUser.set(userId, (regularizationsByUser.get(userId) ?? 0) + 1);
    }

    const [rosterRows, shiftAssignmentRows] = await Promise.all([
      this.db
        .select({
          membershipId: rosterEntries.userMembershipId,
          startTime: shiftTemplates.startTime,
          endTime: shiftTemplates.endTime,
          breakMinutes: shiftTemplates.breakMinutes,
          gracePeriodMinutes: shiftTemplates.gracePeriodMinutes,
        })
        .from(rosterEntries)
        .innerJoin(rosters, and(eq(rosters.id, rosterEntries.rosterId), eq(rosters.orgId, orgId)))
        .innerJoin(shiftTemplates, eq(shiftTemplates.id, rosterEntries.shiftId))
        .where(and(eq(rosterEntries.orgId, orgId), inArray(rosterEntries.userMembershipId, membershipIds), eq(rosterEntries.date, periodStart)))
        .limit(membershipIds.length),

      this.db
        .select({
          membershipId: employeeShiftAssignments.userMembershipId,
          startTime: shiftTemplates.startTime,
          endTime: shiftTemplates.endTime,
          breakMinutes: shiftTemplates.breakMinutes,
          gracePeriodMinutes: shiftTemplates.gracePeriodMinutes,
        })
        .from(employeeShiftAssignments)
        .innerJoin(shiftTemplates, eq(shiftTemplates.id, employeeShiftAssignments.shiftId))
        .where(
          and(
            inArray(employeeShiftAssignments.userMembershipId, membershipIds),
            eq(employeeShiftAssignments.orgId, orgId),
            eq(employeeShiftAssignments.isActive, true),
            lte(employeeShiftAssignments.effectiveFrom, periodStart),
            or(isNull(employeeShiftAssignments.effectiveTo), gte(employeeShiftAssignments.effectiveTo, periodStart)),
          ),
        )
        .limit(membershipIds.length),
    ]);

    const rosterShiftByUser = new Map<string, ShiftInfo>();
    for (const r of rosterRows) {
      if (r.membershipId === null) continue;
      const userId = userIdByMembershipId.get(r.membershipId);
      if (userId && !rosterShiftByUser.has(userId)) rosterShiftByUser.set(userId, r);
    }
    const assignedShiftByUser = new Map<string, ShiftInfo>();
    for (const r of shiftAssignmentRows) {
      if (r.membershipId === null) continue;
      const userId = userIdByMembershipId.get(r.membershipId);
      if (userId && !assignedShiftByUser.has(userId)) assignedShiftByUser.set(userId, r);
    }

    const [attendanceRulesByUser, overtimeRulesByUser] = await Promise.all([
      this.policyService.getAttendanceRulesForEmployees(orgId, userIds, periodStart),
      this.policyService.getOvertimeRulesForEmployees(orgId, userIds, periodStart),
    ]);

    const results: EmployeeAttendanceSummary[] = members.map((member) => {
        const userId = member.userId;
        const rows = attendanceByUser.get(userId) ?? [];

        const attendanceRules = attendanceRulesByUser.get(userId) ?? { graceMinutes: 15, lateArrivalPenalty: "none", halfDayThresholdMinutes: 240, absentThresholdMinutes: 0 };
        const overtimeRules = overtimeRulesByUser.get(userId) ?? { dailyThresholdMinutes: 480 };

        const shiftDef = rosterShiftByUser.get(userId) ?? assignedShiftByUser.get(userId) ?? null;

        const shiftInfo = shiftDef
          ? { shiftStartMinutes: (() => { const [h, m] = shiftDef.startTime.split(":"); return Number(h) * 60 + Number(m); })(), graceMinutes: shiftDef.gracePeriodMinutes }
          : { shiftStartMinutes: 9 * 60, graceMinutes: attendanceRules.graceMinutes };

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
            const localCi = toWallClockUtc(new Date(row.checkIn), orgTimezone);
            const ciMinutes = localCi.getUTCHours() * 60 + localCi.getUTCMinutes();
            if (ciMinutes > shiftInfo.shiftStartMinutes + shiftInfo.graceMinutes) lateCount++;
          }

          if (row.checkOut) {
            const localCo = toWallClockUtc(new Date(row.checkOut), orgTimezone);
            const coMinutes = localCo.getUTCHours() * 60 + localCo.getUTCMinutes();
            if (coMinutes < shiftEndMinutes - 15) earlyExitCount++;
          }

          if (row.isOvertime) {
            const wh = Number(row.workHours ?? 0);
            const thresholdHours = overtimeRules.dailyThresholdMinutes / 60;
            if (wh > thresholdHours) {
              overtimeMinutes += Math.round((wh - thresholdHours) * 60);
            }
          }

          const dateObj = new Date(row.date + "T00:00:00Z");
          const dow = dateObj.getUTCDay();
          if (dow === 0 || dow === 6) weekendWorkDays++;
          if (holidaySet.has(row.date)) holidayWorkDays++;
        }

        const latePenaltyDays = this.calculateLatePenaltyDays(lateCount, attendanceRules.lateArrivalPenalty);
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

    return { data: results, pagination };
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

  private calculateLatePenaltyDays(lateCount: number, penalty: string): number {
    if (penalty === "half_day") return lateCount * 0.5;
    if (penalty === "full_day") return lateCount;
    return 0;
  }
}
