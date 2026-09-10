import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { attendance } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { formatDateOnly, getTodayString } from "../../../common/date";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveAttendanceScope } from "./attendance-scope";
import { AttendancePolicyService } from "./attendance-policy.service";
import { requireOrganizationMembershipId } from "./organization-membership";
import { buildTupleCursorPage, decodeTupleCursor } from "../../../common/pagination/cursor";
import {
  keysetBeforeTuple,
  keysetInteger,
  keysetTextValue,
  keysetTimestamp,
} from "../../../common/pagination/keyset";

type AttendanceStatus = "OFFLINE" | "PRESENT" | "ON_BREAK" | "CHECKED_OUT";

@Injectable()
export class AttendanceReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly policyService: AttendancePolicyService,
  ) {}

  async status(orgId: string, userId: string) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);
    const today = getTodayString();
    const now = new Date();

    const todayLogs = await this.db.query.attendance.findMany({
      where: and(
        eq(attendance.userMembershipId, userMembershipId),
        eq(attendance.date, today),
        eq(attendance.orgId, orgId),
      ),
      orderBy: [desc(attendance.createdAt)],
      limit: 100,
    });

    let dailyWorkHours = 0;
    let dailyBreakHours = 0;
    let isDailyOvertime = false;

    for (const log of todayLogs) {
      dailyBreakHours += Number(log.breakHours || 0);

      if (!log.checkOut && log.checkIn) {
        const start = new Date(log.checkIn);
        const durationMs = now.getTime() - start.getTime();
        const durationHours = durationMs / (1000 * 60 * 60);
        const netWork = durationHours - (Number(log.breakHours) || 0);
        dailyWorkHours += Math.max(0, netWork);
      } else {
        const rawWork = Number(log.workHours || 0);
        const breakHrs = Number(log.breakHours || 0);
        dailyWorkHours += Math.max(0, rawWork - breakHrs);
      }

      if (log.isOvertime) isDailyOvertime = true;
    }

    const openLog = todayLogs.find((log) => !log.checkOut) ?? null;
    const todayLog = openLog ?? todayLogs[0] ?? null;

    let status: AttendanceStatus = "OFFLINE";
    if (todayLog) {
      if (todayLog.checkOut) status = "CHECKED_OUT";
      else if (todayLog.status === "ON_BREAK") status = "ON_BREAK";
      else status = "PRESENT";
    }

    const logs = await this.db.query.attendance.findMany({
      where: and(eq(attendance.userMembershipId, userMembershipId), eq(attendance.orgId, orgId)),
      orderBy: [desc(attendance.createdAt)],
      limit: 10,
    });

    let cooldownRemaining = 0;
    if (status === "CHECKED_OUT" && todayLog?.checkOut) {
      const policy = await this.policyService.getAttendanceRules(
        orgId,
        userId,
        today,
      );
      const lastCheckOut = new Date(todayLog.checkOut);
      const diffMs = now.getTime() - lastCheckOut.getTime();
      const diffMinutes = diffMs / (1000 * 60);
      const cooldownMs = policy.minReclockInMinutes * 60 * 1000;
      if (diffMinutes < policy.minReclockInMinutes) {
        cooldownRemaining = Math.ceil((cooldownMs - diffMs) / 1000);
      }
    }

    return {
      status,
      logs,
      todayLog,
      dailyStats: {
        workHours: dailyWorkHours.toFixed(2),
        breakHours: dailyBreakHours.toFixed(2),
        isOvertime: isDailyOvertime,
      },
      cooldownRemaining,
    };
  }

  async logs(
    u: CurrentUserContext,
    requestedUserId: string | undefined,
    year?: number,
    month?: number,
  ) {
    const userId = requestedUserId ?? u.userId;
    const scope = await resolveAttendanceScope(this.access, u);
    if (!scope.unrestricted && userId !== u.userId) {
      throw new ForbiddenException(
        "Not authorized to view other users' logs.",
      );
    }
    const userMembershipId = await requireOrganizationMembershipId(this.db, u.orgId, userId);
    return this.getAttendanceLogs(u.orgId, userMembershipId, year, month);
  }

  /**
   * Attendance grows by one row per person per day, so this is the deepest
   * list in HR and the one an OFFSET hurt most. The sort is three columns —
   * `date` is not unique per membership (no unique index backs it, only
   * `idx_attendance_org_user_membership_date`), so `created_at` breaks the day
   * tie and the serial id breaks the rest. All three are in the cursor; a
   * two-column one would skip a row every time two records share a day and a
   * millisecond.
   */
  async history(orgId: string, userId: string, cursor: string | undefined, limit: number) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);
    const conditions = [
      eq(attendance.orgId, orgId),
      eq(attendance.userMembershipId, userMembershipId),
    ];

    const position = decodeTupleCursor(cursor, 3);
    if (position) {
      conditions.push(
        keysetBeforeTuple([
          { column: attendance.date, value: keysetTextValue(position[0] ?? "") },
          { column: attendance.createdAt, value: keysetTimestamp(position[1] ?? "") },
          { column: attendance.id, value: keysetInteger(position[2] ?? "") },
        ]),
      );
    }

    const rows = await this.db.query.attendance.findMany({
      where: and(...conditions),
      orderBy: [desc(attendance.date), desc(attendance.createdAt), desc(attendance.id)],
      limit: limit + 1,
    });

    return buildTupleCursorPage(rows, limit, (row) => [
      row.date,
      row.createdAt.toISOString(),
      String(row.id),
    ]);
  }

  private getAttendanceLogs(
    orgId: string,
    userMembershipId: number,
    year?: number,
    month?: number,
  ) {
    if (year !== undefined && month !== undefined) {
      const startDate = new Date(year, month, 1);
      const endDate = new Date(year, month + 1, 0);
      return this.db.query.attendance.findMany({
        where: and(
          eq(attendance.userMembershipId, userMembershipId),
          eq(attendance.orgId, orgId),
          gte(attendance.date, formatDateOnly(startDate)),
          lte(attendance.date, formatDateOnly(endDate)),
        ),
        orderBy: [asc(attendance.date)],
        limit: 200,
      });
    }

    return this.db.query.attendance.findMany({
      where: and(eq(attendance.userMembershipId, userMembershipId), eq(attendance.orgId, orgId)),
      orderBy: [desc(attendance.createdAt)],
      limit: 30,
    });
  }

  async monthly(
    u: CurrentUserContext,
    targetUserId: string,
    year: number,
    month: number,
  ) {
    const scope = await resolveAttendanceScope(this.access, u);
    if (!scope.unrestricted && targetUserId !== u.userId) {
      throw new ForbiddenException(
        "Not authorized to view other users' attendance.",
      );
    }

    const mm = String(month + 1).padStart(2, "0");
    const startDate = `${year}-${mm}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const endDate = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;

    const targetMembershipId = await requireOrganizationMembershipId(this.db, u.orgId, targetUserId);
    return this.db.query.attendance.findMany({
      where: and(
        eq(attendance.userMembershipId, targetMembershipId),
        eq(attendance.orgId, u.orgId),
        gte(attendance.date, startDate),
        lte(attendance.date, endDate),
      ),
      orderBy: [asc(attendance.date)],
      limit: 35,
    });
  }

  async heatmap(u: CurrentUserContext, targetUserId: string, year: number) {
    const scope = await resolveAttendanceScope(this.access, u);
    if (!scope.unrestricted && targetUserId !== u.userId) {
      throw new ForbiddenException(
        "Not authorized to view other users' attendance.",
      );
    }

    const orgId = u.orgId;
    const targetMembershipId = await requireOrganizationMembershipId(this.db, orgId, targetUserId);
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const dailyData = await this.db
      .select({
        date: attendance.date,
        totalHours: sql<string>`COALESCE(SUM(${attendance.workHours}::numeric), 0)`,
        sessions: sql<number>`count(*)`,
      })
      .from(attendance)
      .where(
        and(
          eq(attendance.orgId, orgId),
          eq(attendance.userMembershipId, targetMembershipId),
          gte(attendance.date, startDate),
          lte(attendance.date, endDate),
        ),
      )
      .groupBy(attendance.date)
      .orderBy(attendance.date);

    const heatmap = dailyData.map((d) => ({
      date: d.date,
      hours: Number(Number(d.totalHours).toFixed(1)),
      sessions: Number(d.sessions),
      intensity: Math.min(4, Math.floor(Number(d.totalHours) / 2)),
    }));

    const totalDays = heatmap.length;
    const totalHours = heatmap.reduce((s, d) => s + d.hours, 0);
    const avgHours =
      totalDays > 0 ? (totalHours / totalDays).toFixed(1) : "0.0";
    const longestStreak = this.calculateStreak(heatmap.map((d) => d.date));

    return {
      year,
      userId: targetUserId,
      heatmap,
      summary: {
        totalDays,
        totalHours: totalHours.toFixed(1),
        avgHoursPerDay: avgHours,
        longestStreak,
      },
    };
  }

  private calculateStreak(dates: string[]): number {
    if (dates.length === 0) return 0;
    let maxStreak = 1;
    let currentStreak = 1;
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1]);
      const curr = new Date(dates[i]);
      const diffDays = (curr.getTime() - prev.getTime()) / 86400000;
      if (diffDays === 1) {
        currentStreak++;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else {
        currentStreak = 1;
      }
    }
    return maxStreak;
  }
}
