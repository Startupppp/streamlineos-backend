import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { attendance, geofences, organizations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import type { CheckInInput } from "./dto/attendance.schemas";
import { HrAutomationEngineService } from "../automations/hr-automation-engine.service";
import { AttendancePolicyService } from "./attendance-policy.service";
import {
  AttendanceEventWriterService,
  type AttendanceEventEffect,
  type PreparedAttendanceCommand,
} from "./attendance-event-writer.service";
import { calculateDistanceMeters } from "./attendance-clock-location";
import { requireOrganizationMembershipId } from "./organization-membership";

interface BusinessClockContext {
  businessDate: string;
  organizationTimezone: string;
}

type CanonicalSubjectValues = Partial<
  Pick<
    typeof attendance.$inferInsert,
    "workerId" | "workerEngagementId"
  >
>;

@Injectable()
export class AttendanceClockService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automations: HrAutomationEngineService,
    private readonly policyService: AttendancePolicyService,
    private readonly eventWriter: AttendanceEventWriterService,
  ) {}

  private async getBusinessClockContext(
    organizationId: string,
  ): Promise<BusinessClockContext> {
    const [organization] = await this.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!organization?.timezone) {
      throw new BadRequestException(
        "Configure the organization timezone before recording attendance.",
      );
    }
    try {
      return {
        businessDate: formatInTimeZone(
          new Date(),
          organization.timezone,
          "yyyy-MM-dd",
        ),
        organizationTimezone: organization.timezone,
      };
    } catch {
      throw new BadRequestException(
        "Configure a valid organization timezone before recording attendance.",
      );
    }
  }

  private attendanceLockKey(
    organizationId: string,
    userId: string,
    businessDate: string,
  ) {
    return `${organizationId}:${userId}:${businessDate}`;
  }

  async checkIn(
    organizationId: string,
    userId: string,
    input: CheckInInput,
    idempotencyKey: string,
  ) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, organizationId, userId);
    const clockContext = await this.getBusinessClockContext(organizationId);
    const policy = await this.policyService.getAttendanceRules(
      organizationId,
      userId,
      clockContext.businessDate,
    );
    const shiftInfo =
      await this.policyService.getEffectiveShiftStartWithGrace(
        organizationId,
        userId,
        clockContext.businessDate,
      );

    let locationVerified = false;
    let matchedGeofenceId: number | undefined;

    if (input.location) {
      const geofenceRows = await this.db
        .select()
        .from(geofences)
        .where(
          and(
            eq(geofences.orgId, organizationId),
            eq(geofences.isActive, true),
          ),
        );
      const matchedGeofence = geofenceRows.find(
        (geofence) =>
          calculateDistanceMeters(
            input.location!.lat,
            input.location!.lng,
            Number(geofence.lat),
            Number(geofence.lng),
          ) <= geofence.radiusMeters,
      );

      if (policy.enforceGeofence && geofenceRows.length > 0 && !matchedGeofence) {
        throw new BadRequestException(
          "Check-in location is outside allowed geofences.",
        );
      }
      locationVerified = matchedGeofence !== undefined;
      matchedGeofenceId = matchedGeofence?.id;
    }

    const checkInResult = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.attendanceLockKey(organizationId, userId, clockContext.businessDate)}, 0))`,
      );
      const preparedCommand = await this.eventWriter.prepareCommand(
        transaction,
        {
          organizationId,
          actorUserId: userId,
          businessDate: clockContext.businessDate,
          organizationTimezone: clockContext.organizationTimezone,
          commandScope: "hr.attendance.check-in",
          commandId: idempotencyKey,
        },
      );
      if (preparedCommand?.state === "REPLAY") {
        return { replayed: true as const, occurredAt: null };
      }

      const openSessions = await transaction
        .select({ attendanceId: attendance.id })
        .from(attendance)
        .where(
          and(
            eq(attendance.userMembershipId, userMembershipId),
            eq(attendance.date, clockContext.businessDate),
            eq(attendance.orgId, organizationId),
            isNull(attendance.checkOut),
          ),
        )
        .limit(1)
        .for("update");
      if (openSessions[0]) {
        throw new BadRequestException("Already checked in");
      }

      const latestClosedSessions = await transaction
        .select({ checkOut: attendance.checkOut })
        .from(attendance)
        .where(
          and(
            eq(attendance.userMembershipId, userMembershipId),
            eq(attendance.date, clockContext.businessDate),
            eq(attendance.orgId, organizationId),
          ),
        )
        .orderBy(desc(attendance.createdAt))
        .limit(1)
        .for("update");
      const latestClosedSession = latestClosedSessions[0];
      if (latestClosedSession?.checkOut) {
        const lastCheckOut = new Date(latestClosedSession.checkOut);
        const cooldownMilliseconds = Date.now() - lastCheckOut.getTime();
        const cooldownMinutes = cooldownMilliseconds / (1000 * 60);
        if (cooldownMinutes < policy.minReclockInMinutes) {
          throw new BadRequestException(
            `Please wait ${policy.minReclockInMinutes} minute${policy.minReclockInMinutes !== 1 ? "s" : ""} before clocking in again.`,
          );
        }
      }

      const occurredAt = new Date();
      await transaction.insert(attendance).values({
        orgId: organizationId,
        userId,
        userMembershipId,
        date: clockContext.businessDate,
        checkIn: occurredAt,
        status: "PRESENT",
        locationData: input.location ?? null,
        locationVerified,
        ...this.canonicalSubjectValues(preparedCommand),
      });
      await this.appendCanonicalEffects(transaction, preparedCommand, [
        {
          eventKind: "CHECK_IN",
          occurredAt,
          ...(matchedGeofenceId === undefined
            ? {}
            : { geofenceId: matchedGeofenceId, geofencePassed: true }),
        },
      ]);
      return { replayed: false as const, occurredAt };
    });

    if (checkInResult.replayed || !checkInResult.occurredAt) {
      return { success: true };
    }

    const checkInMinutes =
      checkInResult.occurredAt.getHours() * 60 +
      checkInResult.occurredAt.getMinutes();
    const lateThreshold = shiftInfo.shiftStartMinutes + shiftInfo.graceMinutes;
    if (checkInMinutes > lateThreshold) {
      const minutesLate = checkInMinutes - shiftInfo.shiftStartMinutes;
      this.automations
        .emit(organizationId, "attendance.late", {
          employeeId: userId,
          minutesLate,
          attendanceStatus: "late",
        })
        .catch(() => undefined);
    }

    return { success: true };
  }

  async checkOut(
    organizationId: string,
    userId: string,
    idempotencyKey: string,
  ) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, organizationId, userId);
    const clockContext = await this.getBusinessClockContext(organizationId);
    const overtimeRules = await this.policyService.getOvertimeRules(
      organizationId,
      userId,
      clockContext.businessDate,
    );
    const dailyThresholdHours = overtimeRules.dailyThresholdMinutes / 60;

    await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.attendanceLockKey(organizationId, userId, clockContext.businessDate)}, 0))`,
      );
      const preparedCommand = await this.eventWriter.prepareCommand(
        transaction,
        {
          organizationId,
          actorUserId: userId,
          businessDate: clockContext.businessDate,
          organizationTimezone: clockContext.organizationTimezone,
          commandScope: "hr.attendance.check-out",
          commandId: idempotencyKey,
        },
      );
      if (preparedCommand?.state === "REPLAY") return;

      const [attendanceSession] = await transaction
        .select({
          attendanceId: attendance.id,
          checkIn: attendance.checkIn,
          breakHours: attendance.breakHours,
          breaks: attendance.breaks,
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.userMembershipId, userMembershipId),
            eq(attendance.date, clockContext.businessDate),
            eq(attendance.orgId, organizationId),
            isNull(attendance.checkOut),
          ),
        )
        .orderBy(desc(attendance.createdAt))
        .limit(1)
        .for("update");

      if (!attendanceSession) {
        throw new BadRequestException("Cannot check out");
      }
      if (!attendanceSession.checkIn) {
        throw new BadRequestException("Missing check-in time");
      }

      const occurredAt = new Date();
      let totalBreakHours = Number(attendanceSession.breakHours) || 0;
      const currentBreaks = attendanceSession.breaks ?? [];
      let updatedBreaks = currentBreaks;
      const canonicalEffects: AttendanceEventEffect[] = [];
      const activeBreak = currentBreaks[currentBreaks.length - 1];
      if (activeBreak && !activeBreak.end) {
        updatedBreaks = currentBreaks.map((breakPeriod, breakIndex) =>
          breakIndex === currentBreaks.length - 1
            ? { ...breakPeriod, end: occurredAt.toISOString() }
            : breakPeriod,
        );
        const breakStartedAt = new Date(activeBreak.start);
        const breakDurationHours =
          (occurredAt.getTime() - breakStartedAt.getTime()) / 3_600_000;
        totalBreakHours += Math.max(0, breakDurationHours);
        canonicalEffects.push({ eventKind: "BREAK_END", occurredAt });
      }

      const checkInTime = new Date(attendanceSession.checkIn);
      const durationMilliseconds = Math.max(
        0,
        occurredAt.getTime() - checkInTime.getTime(),
      );
      const sessionWorkHours = Math.max(
        0,
        durationMilliseconds / 3_600_000 - totalBreakHours,
      );

      const dailyAttendanceRows = await transaction
        .select({
          attendanceId: attendance.id,
          workHours: attendance.workHours,
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.userMembershipId, userMembershipId),
            eq(attendance.date, clockContext.businessDate),
            eq(attendance.orgId, organizationId),
          ),
        );

      let previousWorkHours = 0;
      for (const dailyAttendanceRow of dailyAttendanceRows) {
        if (
          dailyAttendanceRow.attendanceId !== attendanceSession.attendanceId
        ) {
          previousWorkHours += Number(dailyAttendanceRow.workHours || 0);
        }
      }

      const totalDailyWork = previousWorkHours + sessionWorkHours;
      const isOvertime = totalDailyWork > dailyThresholdHours;

      await transaction
        .update(attendance)
        .set({
          checkOut: occurredAt,
          status: "CHECKED_OUT",
          workHours: sessionWorkHours.toFixed(2),
          breakHours: totalBreakHours.toFixed(2),
          breaks: updatedBreaks,
          isOvertime,
          ...this.canonicalSubjectValues(preparedCommand),
        })
        .where(eq(attendance.id, attendanceSession.attendanceId));
      canonicalEffects.push({ eventKind: "CHECK_OUT", occurredAt });
      await this.appendCanonicalEffects(
        transaction,
        preparedCommand,
        canonicalEffects,
      );
    });

    return { success: true };
  }

  async toggleBreak(
    organizationId: string,
    userId: string,
    idempotencyKey: string,
  ) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, organizationId, userId);
    const clockContext = await this.getBusinessClockContext(organizationId);

    await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.attendanceLockKey(organizationId, userId, clockContext.businessDate)}, 0))`,
      );
      const preparedCommand = await this.eventWriter.prepareCommand(
        transaction,
        {
          organizationId,
          actorUserId: userId,
          businessDate: clockContext.businessDate,
          organizationTimezone: clockContext.organizationTimezone,
          commandScope: "hr.attendance.toggle-break",
          commandId: idempotencyKey,
        },
      );
      if (preparedCommand?.state === "REPLAY") return;

      const [attendanceSession] = await transaction
        .select({
          attendanceId: attendance.id,
          status: attendance.status,
          breaks: attendance.breaks,
          breakHours: attendance.breakHours,
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.userMembershipId, userMembershipId),
            eq(attendance.date, clockContext.businessDate),
            eq(attendance.orgId, organizationId),
            isNull(attendance.checkOut),
          ),
        )
        .orderBy(desc(attendance.createdAt))
        .limit(1)
        .for("update");

      if (!attendanceSession) {
        throw new BadRequestException("Invalid action");
      }

      const occurredAt = new Date();
      const currentBreaks = attendanceSession.breaks ?? [];

      if (attendanceSession.status === "PRESENT") {
        await transaction
          .update(attendance)
          .set({
            status: "ON_BREAK",
            breaks: [...currentBreaks, { start: occurredAt.toISOString() }],
            ...this.canonicalSubjectValues(preparedCommand),
          })
          .where(eq(attendance.id, attendanceSession.attendanceId));
        await this.appendCanonicalEffects(transaction, preparedCommand, [
          { eventKind: "BREAK_START", occurredAt },
        ]);
        return;
      }

      const activeBreak = currentBreaks[currentBreaks.length - 1];
      if (!activeBreak || activeBreak.end) {
        throw new BadRequestException("Invalid action");
      }
      const updatedBreaks = currentBreaks.map((breakPeriod, breakIndex) =>
        breakIndex === currentBreaks.length - 1
          ? { ...breakPeriod, end: occurredAt.toISOString() }
          : breakPeriod,
      );
      const breakStartedAt = new Date(activeBreak.start);
      const breakDurationHours =
        (occurredAt.getTime() - breakStartedAt.getTime()) / 3_600_000;
      const totalBreakHours =
        (Number(attendanceSession.breakHours) || 0) + breakDurationHours;
      await transaction
        .update(attendance)
        .set({
          status: "PRESENT",
          breaks: updatedBreaks,
          breakHours: totalBreakHours.toFixed(2),
          ...this.canonicalSubjectValues(preparedCommand),
        })
        .where(eq(attendance.id, attendanceSession.attendanceId));
      await this.appendCanonicalEffects(transaction, preparedCommand, [
        { eventKind: "BREAK_END", occurredAt },
      ]);
    });

    return { success: true };
  }

  private canonicalSubjectValues(
    command: PreparedAttendanceCommand | null,
  ): CanonicalSubjectValues {
    if (command?.state !== "CANONICAL") return {};
    return {
      workerId: command.workerId,
      workerEngagementId: command.workerEngagementId,
    };
  }

  private async appendCanonicalEffects(
    transaction: TenantTx,
    command: PreparedAttendanceCommand | null,
    effects: readonly AttendanceEventEffect[],
  ): Promise<void> {
    if (command?.state !== "CANONICAL") return;
    await this.eventWriter.appendEvents(transaction, command, effects);
  }
}
