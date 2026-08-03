import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { attendance } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { HrAutomationEngineService } from "../hr/automations/hr-automation-engine.service";
import { AttendancePolicyService } from "../hr/time/attendance-policy.service";
import { forEachOrg } from "../../common/tenant";

const DEFAULT_AUTO_CHECKOUT_TIME = "19:00";
const DEFAULT_BREAK_HOURS_AUTO_CHECKOUT = 1;
const FALLBACK_TZ_OFFSET_MINUTES = 0;

@Injectable()
export class CronAttendanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automations: HrAutomationEngineService,
    private readonly policyService: AttendancePolicyService,
  ) {}

  async processAutoCheckout(): Promise<{ processed: number; message: string }> {
    let processed = 0;
    const now = Date.now();

    await forEachOrg(this.db, "auto-checkout", async (tx, orgId) => {
      const openRecords = await tx.query.attendance.findMany({
        where: and(eq(attendance.orgId, orgId), isNull(attendance.checkOut)),
        columns: {
          id: true,
          orgId: true,
          userId: true,
          checkIn: true,
          autoCheckedOut: true,
          date: true,
          breaks: true,
          breakHours: true,
        },
      });

      for (const record of openRecords) {
        if (!record.checkIn || record.autoCheckedOut || !record.date) continue;

        const policy = await this.policyService.getAttendanceRules(record.orgId, record.userId, record.date);
        const autoCheckoutTime = policy.autoCheckoutTime ?? DEFAULT_AUTO_CHECKOUT_TIME;

        const overtimeRules = await this.policyService.getOvertimeRules(record.orgId, record.userId, record.date);
        const dailyThresholdHours = overtimeRules.dailyThresholdMinutes / 60;

        const checkOutTime = this.policyService.parseAutoCheckoutTimeToUtc(
          autoCheckoutTime,
          record.date,
          FALLBACK_TZ_OFFSET_MINUTES,
        );

        if (checkOutTime.getTime() > now) continue;

        const checkInTime = new Date(record.checkIn);

        if (checkInTime >= checkOutTime) {
          const result = await tx
            .update(attendance)
            .set({
              checkOut: checkOutTime,
              workHours: "0",
              status: "CHECKED_OUT",
              autoCheckedOut: true,
              isOvertime: false,
            })
            .where(and(eq(attendance.id, record.id), isNull(attendance.checkOut)))
            .returning({ id: attendance.id });

          if (result.length > 0) processed++;
          continue;
        }

        const breaks = record.breaks ?? [];
        let totalBreakHours = Number(record.breakHours) || 0;

        for (const b of breaks) {
          if (!b.end) {
            b.end = checkOutTime.toISOString();
            const breakStart = new Date(b.start);
            const breakDuration = (checkOutTime.getTime() - breakStart.getTime()) / (1000 * 60 * 60);
            totalBreakHours += Math.max(0, breakDuration);
          }
        }

        const effectiveBreakHours = Math.max(totalBreakHours, DEFAULT_BREAK_HOURS_AUTO_CHECKOUT);
        const durationMs = checkOutTime.getTime() - checkInTime.getTime();
        const workHours = Math.max(0, durationMs / (1000 * 60 * 60) - effectiveBreakHours);
        const isOvertime = workHours > dailyThresholdHours;

        const result = await tx
          .update(attendance)
          .set({
            checkOut: checkOutTime,
            workHours: workHours.toFixed(2),
            breakHours: effectiveBreakHours.toFixed(2),
            breaks,
            status: "CHECKED_OUT",
            autoCheckedOut: true,
            isOvertime,
          })
          .where(and(eq(attendance.id, record.id), isNull(attendance.checkOut)))
          .returning({ id: attendance.id });

        if (result.length > 0) {
          processed++;
          this.automations
            .emit(record.orgId, "attendance.missed_punch", { employeeId: record.userId, date: record.date })
            .catch(() => undefined);
        }
      }
    });

    return {
      processed,
      message: `Auto-checked out ${processed} attendance records`,
    };
  }
}
