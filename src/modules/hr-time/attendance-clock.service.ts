import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { attendance, geofences } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { getTodayString } from "../../common/date";
import type { CheckInInput } from "./dto/attendance.schemas";
import { HrAutomationEngineService } from "../hr-automations/hr-automation-engine.service";
import { AttendancePolicyService } from "./attendance-policy.service";

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

@Injectable()
export class AttendanceClockService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automations: HrAutomationEngineService,
    private readonly policyService: AttendancePolicyService,
  ) {}

  async checkIn(orgId: string, userId: string, body: CheckInInput) {
    const today = body.localDate ?? getTodayString();

    const policy = await this.policyService.getAttendanceRules(
      orgId,
      userId,
      today,
    );
    const shiftInfo =
      await this.policyService.getEffectiveShiftStartWithGrace(
        orgId,
        userId,
        today,
      );

    let locationVerified = false;

    if (policy.enforceGeofence && body.location) {
      const fences = await this.db
        .select()
        .from(geofences)
        .where(and(eq(geofences.orgId, orgId), eq(geofences.isActive, true)));

      if (fences.length > 0) {
        const within = fences.some(
          (f) =>
            haversineMeters(
              body.location!.lat,
              body.location!.lng,
              Number(f.lat),
              Number(f.lng),
            ) <= f.radiusMeters,
        );
        if (!within) {
          throw new BadRequestException(
            "Check-in location is outside allowed geofences.",
          );
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
            haversineMeters(
              body.location!.lat,
              body.location!.lng,
              Number(f.lat),
              Number(f.lng),
            ) <= f.radiusMeters,
        );
      }
    }

    await this.db.transaction(async (tx) => {
      const openSessions = await tx
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
        .limit(1)
        .for("update");

      if (openSessions[0]) {
        throw new BadRequestException("Already checked in");
      }

      const latestClosed = await tx
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

      const existing = latestClosed[0];
      if (existing?.checkOut) {
        const lastCheckOut = new Date(existing.checkOut);
        const cooldownDiff = new Date().getTime() - lastCheckOut.getTime();
        const diffMinutes = cooldownDiff / (1000 * 60);
        if (diffMinutes < policy.minReclockInMinutes) {
          throw new BadRequestException(
            `Please wait ${policy.minReclockInMinutes} minute${policy.minReclockInMinutes !== 1 ? "s" : ""} before clocking in again.`,
          );
        }
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
    const checkInMinutes =
      checkInTime.getHours() * 60 + checkInTime.getMinutes();
    const lateThreshold =
      shiftInfo.shiftStartMinutes + shiftInfo.graceMinutes;

    if (checkInMinutes > lateThreshold) {
      const minutesLate = checkInMinutes - shiftInfo.shiftStartMinutes;
      this.automations
        .emit(orgId, "attendance.late", {
          employeeId: userId,
          minutesLate,
          attendanceStatus: "late",
        })
        .catch(() => undefined);
    }

    return { success: true };
  }

  async checkOut(orgId: string, userId: string, localDate?: string) {
    const today = localDate ?? getTodayString();

    const overtimeRules = await this.policyService.getOvertimeRules(
      orgId,
      userId,
      today,
    );
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
      const sessionWorkHours = Math.max(
        0,
        durationMs / (1000 * 60 * 60) - totalBreakHours,
      );

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
          status: "CHECKED_OUT",
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
          .set({
            status: "PRESENT",
            breaks,
            breakHours: totalBreak.toFixed(2),
          })
          .where(eq(attendance.id, log.id));
      }
    }

    return { success: true };
  }
}
