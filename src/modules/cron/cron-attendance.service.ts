import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { attendance } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

const AUTO_CHECKOUT_IST_HOUR = 19;
const DEFAULT_AUTO_CHECKOUT_BREAK_HOURS = 1;
const IST_OFFSET_MINUTES = 330;

function istSevenPmUtcForDateStr(dateStr: string): Date {
  const parts = dateStr.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!year || !month || !day) {
    throw new Error(`Invalid attendance date string: ${dateStr}`);
  }
  const istMinutesFromMidnight = AUTO_CHECKOUT_IST_HOUR * 60;
  const utcMinutesFromMidnight = istMinutesFromMidnight - IST_OFFSET_MINUTES;
  const utcHours = Math.floor(utcMinutesFromMidnight / 60);
  const utcMinutes = utcMinutesFromMidnight % 60;
  return new Date(Date.UTC(year, month - 1, day, utcHours, utcMinutes, 0, 0));
}

@Injectable()
export class CronAttendanceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async processAutoCheckout(): Promise<{ processed: number; message: string }> {
    const openRecords = await this.db.query.attendance.findMany({
      where: isNull(attendance.checkOut),
      columns: {
        id: true,
        checkIn: true,
        autoCheckedOut: true,
        date: true,
        breaks: true,
        breakHours: true,
      },
    });

    if (openRecords.length === 0) {
      return { processed: 0, message: "No open attendance records found" };
    }

    let processed = 0;
    const now = Date.now();

    for (const record of openRecords) {
      if (!record.checkIn || record.autoCheckedOut || !record.date) continue;

      const checkInTime = new Date(record.checkIn);
      const checkOutTime = istSevenPmUtcForDateStr(record.date);

      if (checkOutTime.getTime() > now) continue;

      if (checkInTime >= checkOutTime) {
        const result = await this.db
          .update(attendance)
          .set({
            checkOut: checkOutTime,
            workHours: "0",
            status: "PRESENT",
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

      const effectiveBreakHours = Math.max(totalBreakHours, DEFAULT_AUTO_CHECKOUT_BREAK_HOURS);
      const durationMs = checkOutTime.getTime() - checkInTime.getTime();
      const workHours = Math.max(0, durationMs / (1000 * 60 * 60) - effectiveBreakHours);
      const isOvertime = workHours > 8;

      const result = await this.db
        .update(attendance)
        .set({
          checkOut: checkOutTime,
          workHours: workHours.toFixed(2),
          breakHours: effectiveBreakHours.toFixed(2),
          breaks,
          status: "PRESENT",
          autoCheckedOut: true,
          isOvertime,
        })
        .where(and(eq(attendance.id, record.id), isNull(attendance.checkOut)))
        .returning({ id: attendance.id });

      if (result.length > 0) processed++;
    }

    return {
      processed,
      message: `Auto-checked out ${processed} attendance records`,
    };
  }
}
