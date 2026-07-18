import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { attendance, departments, geofences, organizationMembers, organizations, orgHolidays, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { EmailService } from "../email/email.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { formatDateOnly, getTodayString } from "./date.helpers";
import type { AttendanceEmailReportInput, CheckInInput } from "./dto/attendance.schemas";
import { resolveAttendanceScope } from "./attendance-scope";
import { randomUUID } from "node:crypto";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";
import { AttendancePolicyService } from "./attendance-policy.service";

type AttendanceStatus = "OFFLINE" | "PRESENT" | "ON_BREAK" | "CHECKED_OUT";

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

@Injectable()
export class AttendanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly email: EmailService,
    private readonly automations: HrAutomationEngineService,
    private readonly policyService: AttendancePolicyService,
  ) {}

  async checkIn(orgId: string, userId: string, body: CheckInInput) {
    const today = body.localDate ?? getTodayString();

    const policy = await this.policyService.getAttendanceRules(orgId, userId, today);
    const shiftInfo = await this.policyService.getEffectiveShiftStartWithGrace(orgId, userId, today);

    let locationVerified = false;

    if (policy.enforceGeofence && body.location) {
      const fences = await this.db
        .select()
        .from(geofences)
        .where(and(eq(geofences.orgId, orgId), eq(geofences.isActive, true)));

      if (fences.length > 0) {
        const within = fences.some(
          (f) =>
            haversineMeters(body.location!.lat, body.location!.lng, Number(f.lat), Number(f.lng)) <=
            f.radiusMeters,
        );
        if (!within) {
          throw new BadRequestException("Check-in location is outside allowed geofences.");
        }
        locationVerified = true;
      }
    } else if (body.location) {
      const fences = await this.db
        .select()
        .from(geofences)
        .where(and(eq(geofences.orgId, orgId), eq(geofences.isActive, true)));

      if (fences.length > 0) {
        locationVerified = fences.some(
          (f) =>
            haversineMeters(body.location!.lat, body.location!.lng, Number(f.lat), Number(f.lng)) <=
            f.radiusMeters,
        );
      }
    }

    await this.db.transaction(async (tx) => {
      const result = await tx
        .select()
        .from(attendance)
        .where(
          and(
            eq(attendance.userId, userId),
            eq(attendance.date, today),
            eq(attendance.orgId, orgId),
          ),
        )
        .orderBy(desc(attendance.createdAt))
        .limit(1)
        .for("update");

      const existing = result[0];

      if (existing) {
        if (!existing.checkOut) {
          throw new BadRequestException("Already checked in");
        }

        const lastCheckOut = new Date(existing.checkOut);
        const cooldownDiff = new Date().getTime() - lastCheckOut.getTime();
        const diffMinutes = cooldownDiff / (1000 * 60);
        if (diffMinutes < policy.minReclockInMinutes) {
          throw new BadRequestException(
            `Please wait ${policy.minReclockInMinutes} minute${policy.minReclockInMinutes !== 1 ? "s" : ""} before clocking in again.`,
          );
        }

        const now = new Date();
        const gapMs = now.getTime() - lastCheckOut.getTime();
        const gapHours = gapMs / (1000 * 60 * 60);

        const currentBreaks = existing.breaks ?? [];
        const newBreaks = [
          ...currentBreaks,
          { start: lastCheckOut.toISOString(), end: now.toISOString() },
        ];
        const newBreakHours = (Number(existing.breakHours) || 0) + gapHours;

        await tx
          .update(attendance)
          .set({
            status: "PRESENT",
            checkOut: null,
            breaks: newBreaks,
            breakHours: newBreakHours.toFixed(2),
            locationVerified,
          })
          .where(eq(attendance.id, existing.id));

        return;
      }

      await tx.insert(attendance).values({
        orgId,
        userId,
        date: today,
        checkIn: new Date(),
        status: "PRESENT",
        locationData: body.location ?? null,
        locationVerified,
      });
    });

    const checkInTime = new Date();
    const checkInMinutes = checkInTime.getHours() * 60 + checkInTime.getMinutes();
    const lateThreshold = shiftInfo.shiftStartMinutes + shiftInfo.graceMinutes;

    if (checkInMinutes > lateThreshold) {
      const minutesLate = checkInMinutes - shiftInfo.shiftStartMinutes;
      this.automations
        .emit(orgId, "attendance.late", { employeeId: userId, minutesLate, attendanceStatus: "late" })
        .catch(() => undefined);
    }

    return { success: true };
  }

  async checkOut(orgId: string, userId: string, localDate?: string) {
    const today = localDate ?? getTodayString();

    const overtimeRules = await this.policyService.getOvertimeRules(orgId, userId, today);
    const dailyThresholdHours = overtimeRules.dailyThresholdMinutes / 60;

    await this.db.transaction(async (tx) => {
      const result = await tx
        .select()
        .from(attendance)
        .where(
          and(
            eq(attendance.userId, userId),
            eq(attendance.date, today),
            eq(attendance.orgId, orgId),
            isNull(attendance.checkOut),
          ),
        )
        .orderBy(desc(attendance.createdAt))
        .limit(1)
        .for("update");

      const log = result[0];
      if (!log) throw new BadRequestException("Cannot check out");
      if (!log.checkIn) throw new BadRequestException("Missing check-in time");

      const now = new Date();
      let totalBreakHours = Number(log.breakHours) || 0;
      const breaks = log.breaks ?? [];
      const updatedBreaks = [...breaks];

      const lastBreak = updatedBreaks[updatedBreaks.length - 1];
      if (lastBreak && !lastBreak.end) {
        lastBreak.end = now.toISOString();
        const start = new Date(lastBreak.start);
        const duration = (now.getTime() - start.getTime()) / (1000 * 60 * 60);
        totalBreakHours += Math.max(0, duration);
      }

      const checkInTime = new Date(log.checkIn);
      const durationMs = Math.max(0, now.getTime() - checkInTime.getTime());
      const sessionWorkHours = Math.max(0, durationMs / (1000 * 60 * 60) - totalBreakHours);

      const todayLogs = await tx.query.attendance.findMany({
        where: and(
          eq(attendance.userId, userId),
          eq(attendance.date, today),
          eq(attendance.orgId, orgId),
        ),
      });

      let previousWorkHours = 0;
      for (const l of todayLogs) {
        if (l.id !== log.id) {
          previousWorkHours += Number(l.workHours || 0);
        }
      }

      const totalDailyWork = previousWorkHours + sessionWorkHours;
      const isOvertime = totalDailyWork > dailyThresholdHours;

      await tx
        .update(attendance)
        .set({
          checkOut: now,
          status: "PRESENT",
          workHours: sessionWorkHours.toFixed(2),
          breakHours: totalBreakHours.toFixed(2),
          breaks: updatedBreaks,
          isOvertime,
        })
        .where(eq(attendance.id, log.id));
    });

    return { success: true };
  }

  async toggleBreak(orgId: string, userId: string) {
    const today = getTodayString();

    const log = await this.db.query.attendance.findFirst({
      where: and(
        eq(attendance.userId, userId),
        eq(attendance.date, today),
        eq(attendance.orgId, orgId),
        isNull(attendance.checkOut),
      ),
    });

    if (!log) throw new BadRequestException("Invalid action");

    const now = new Date();
    const breaks = log.breaks ?? [];

    if (log.status === "PRESENT") {
      const newBreaks = [...breaks, { start: now.toISOString() }];
      await this.db
        .update(attendance)
        .set({ status: "ON_BREAK", breaks: newBreaks })
        .where(eq(attendance.id, log.id));
    } else {
      const lastBreak = breaks[breaks.length - 1];
      if (lastBreak && !lastBreak.end) {
        lastBreak.end = now.toISOString();
        const start = new Date(lastBreak.start);
        const duration = (now.getTime() - start.getTime()) / (1000 * 60 * 60);
        const totalBreak = (Number(log.breakHours) || 0) + duration;
        await this.db
          .update(attendance)
          .set({ status: "PRESENT", breaks, breakHours: totalBreak.toFixed(2) })
          .where(eq(attendance.id, log.id));
      }
    }

    return { success: true };
  }

  async status(orgId: string, userId: string) {
    const today = getTodayString();
    const now = new Date();

    const todayLogs = await this.db.query.attendance.findMany({
      where: and(
        eq(attendance.userId, userId),
        eq(attendance.date, today),
        eq(attendance.orgId, orgId),
      ),
      orderBy: [desc(attendance.createdAt)],
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

    const todayLog = todayLogs[0] ?? null;

    let status: AttendanceStatus = "OFFLINE";
    if (todayLog) {
      if (todayLog.checkOut) status = "CHECKED_OUT";
      else if (todayLog.status === "ON_BREAK") status = "ON_BREAK";
      else status = "PRESENT";
    }

    const logs = await this.db.query.attendance.findMany({
      where: and(eq(attendance.userId, userId), eq(attendance.orgId, orgId)),
      orderBy: [desc(attendance.createdAt)],
      limit: 10,
    });

    let cooldownRemaining = 0;
    if (status === "CHECKED_OUT" && todayLog?.checkOut) {
      const policy = await this.policyService.getAttendanceRules(orgId, userId, today);
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
    if (scope !== "all" && userId !== u.userId) {
      throw new ForbiddenException("Not authorized to view other users' logs.");
    }
    return this.getAttendanceLogs(u.orgId, userId, year, month);
  }

  private getAttendanceLogs(orgId: string, userId: string, year?: number, month?: number) {
    if (year !== undefined && month !== undefined) {
      const startDate = new Date(year, month, 1);
      const endDate = new Date(year, month + 1, 0);
      return this.db.query.attendance.findMany({
        where: and(
          eq(attendance.userId, userId),
          eq(attendance.orgId, orgId),
          gte(attendance.date, formatDateOnly(startDate)),
          lte(attendance.date, formatDateOnly(endDate)),
        ),
        orderBy: [asc(attendance.date)],
      });
    }

    return this.db.query.attendance.findMany({
      where: and(eq(attendance.userId, userId), eq(attendance.orgId, orgId)),
      orderBy: [desc(attendance.createdAt)],
      limit: 30,
    });
  }

  async monthly(u: CurrentUserContext, targetUserId: string, year: number, month: number) {
    const scope = await resolveAttendanceScope(this.access, u);
    if (scope !== "all" && targetUserId !== u.userId) {
      throw new ForbiddenException("Not authorized to view other users' attendance.");
    }

    const mm = String(month + 1).padStart(2, "0");
    const startDate = `${year}-${mm}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const endDate = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;

    return this.db.query.attendance.findMany({
      where: and(
        eq(attendance.userId, targetUserId),
        eq(attendance.orgId, u.orgId),
        gte(attendance.date, startDate),
        lte(attendance.date, endDate),
      ),
      orderBy: [asc(attendance.date)],
    });
  }

  async heatmap(u: CurrentUserContext, targetUserId: string, year: number) {
    const scope = await resolveAttendanceScope(this.access, u);
    if (scope !== "all" && targetUserId !== u.userId) {
      throw new ForbiddenException("Not authorized to view other users' attendance.");
    }

    const orgId = u.orgId;
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
          eq(attendance.userId, targetUserId),
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
    const avgHours = totalDays > 0 ? (totalHours / totalDays).toFixed(1) : "0.0";
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

  async teamStatus(u: CurrentUserContext) {
    const scope = await resolveAttendanceScope(this.access, u);
    if (scope !== "all") throw new ForbiddenException("Only admins can view team attendance.");

    const today = getTodayString();

    const members = await this.db
      .select({
        userId: organizationMembers.userId,
        userName: users.name,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
        userImage: users.image,
        isActive: users.isActive,
        departmentId: users.departmentId,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, u.orgId));

    const activeMembers = members.filter((m) => m.isActive !== false);

    const deptIds = [...new Set(activeMembers.map((m) => m.departmentId).filter(Boolean))].filter(
      (id): id is number => id !== null,
    );
    const deptMap = new Map<number, string>();
    if (deptIds.length > 0) {
      const deptRows = await this.db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(inArray(departments.id, deptIds));
      for (const d of deptRows) deptMap.set(d.id, d.name);
    }

    const userIds = activeMembers.map((m) => m.userId);
    const todayLogs =
      userIds.length > 0
        ? await this.db.query.attendance.findMany({
            where: and(
              eq(attendance.orgId, u.orgId),
              eq(attendance.date, today),
              inArray(attendance.userId, userIds),
            ),
          })
        : [];

    const logsByUser = new Map<string, (typeof todayLogs)[number]>();
    for (const log of todayLogs) {
      const existing = logsByUser.get(log.userId);
      if (!existing || (log.createdAt && existing.createdAt && log.createdAt > existing.createdAt)) {
        logsByUser.set(log.userId, log);
      }
    }

    const result = activeMembers.map((m) => {
      const log = logsByUser.get(m.userId);
      let memberStatus: AttendanceStatus = "OFFLINE";
      if (log) {
        if (log.checkOut) memberStatus = "CHECKED_OUT";
        else if (log.status === "ON_BREAK") memberStatus = "ON_BREAK";
        else memberStatus = "PRESENT";
      }

      const name =
        m.userName ||
        [m.userFirstName, m.userLastName].filter(Boolean).join(" ") ||
        m.userEmail;

      return {
        userId: m.userId,
        name,
        email: m.userEmail,
        image: m.userImage,
        department: m.departmentId ? (deptMap.get(m.departmentId) ?? null) : null,
        status: memberStatus,
        checkIn: log?.checkIn ?? null,
        checkOut: log?.checkOut ?? null,
        workHours: log?.workHours ?? null,
      };
    });

    const order: Record<AttendanceStatus, number> = {
      PRESENT: 0,
      ON_BREAK: 1,
      CHECKED_OUT: 2,
      OFFLINE: 3,
    };
    result.sort((a, b) => order[a.status] - order[b.status]);

    return result;
  }

  async listHolidays(orgId: string) {
    return this.db
      .select()
      .from(orgHolidays)
      .where(eq(orgHolidays.orgId, orgId))
      .orderBy(asc(orgHolidays.date))
      .limit(100);
  }

  async createHoliday(orgId: string, createdBy: string, data: { name: string; date: string; recurring?: boolean }) {
    const trimmedName = data.name.trim();
    const duplicate = await this.db.query.orgHolidays.findFirst({
      where: and(
        eq(orgHolidays.orgId, orgId),
        eq(orgHolidays.date, data.date),
        sql`lower(trim(${orgHolidays.name})) = ${trimmedName.toLowerCase()}`,
      ),
      columns: { id: true },
    });
    if (duplicate) {
      throw new ConflictException("A holiday with this name already exists on this date.");
    }
    const [holiday] = await this.db
      .insert(orgHolidays)
      .values({ id: randomUUID(), orgId, createdBy, name: trimmedName, date: data.date, recurring: data.recurring ?? false })
      .returning();
    return holiday;
  }

  async updateHoliday(orgId: string, id: string, data: { name?: string; date?: string; recurring?: boolean }) {
    const updateData: { name?: string; date?: string; recurring?: boolean } = { ...data };
    if (updateData.name !== undefined) {
      updateData.name = updateData.name.trim();
    }
    const [holiday] = await this.db
      .update(orgHolidays)
      .set(updateData)
      .where(and(eq(orgHolidays.id, id), eq(orgHolidays.orgId, orgId)))
      .returning();
    if (!holiday) throw new NotFoundException("Holiday not found");
    return holiday;
  }

  async deleteHoliday(orgId: string, id: string) {
    await this.db
      .delete(orgHolidays)
      .where(and(eq(orgHolidays.id, id), eq(orgHolidays.orgId, orgId)));
  }

  async emailReport(u: CurrentUserContext, input: AttendanceEmailReportInput): Promise<{ sent: number }> {
    const now = new Date();
    const startDate = input.startDate ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const endDate = input.endDate ?? formatDateOnly(now);

    const [orgRow, rows] = await Promise.all([
      this.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, u.orgId))
        .then((r) => r[0]),
      this.db
        .select({
          date: attendance.date,
          userName: sql<string>`coalesce(${users.name}, ${users.email}, 'Unknown')`,
          workHours: attendance.workHours,
          autoCheckout: attendance.autoCheckedOut,
        })
        .from(attendance)
        .innerJoin(users, eq(users.id, attendance.userId))
        .where(
          and(
            eq(attendance.orgId, u.orgId),
            gte(attendance.date, startDate),
            lte(attendance.date, endDate),
          ),
        )
        .orderBy(asc(attendance.date), asc(users.name)),
    ]);

    const orgName = orgRow?.name ?? "Your Organisation";
    const dateRange = `${startDate} to ${endDate}`;
    const recipients = [...input.to, ...input.cc, ...input.bcc];

    await this.email.sendWeeklyAttendanceReportEmail(
      dateRange,
      orgName,
      rows.map((r) => ({
        department: "",
        name: r.userName,
        totalHours: r.workHours ?? "0",
        autoCheckoutDays: r.autoCheckout ? 1 : 0,
        overtimeDays: 0,
        daysPresent: 1,
      })),
      recipients,
    );

    return { sent: recipients.length };
  }
}
