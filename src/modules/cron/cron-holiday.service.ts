import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { holidays } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";

export type HolidayNotificationResult =
  | { success: true; count: number }
  | { error: string };

@Injectable()
export class CronHolidayService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sendHolidayNotifications(): Promise<HolidayNotificationResult> {
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowDate = tomorrow.toISOString().slice(0, 10);

      const upcomingHolidays = await this.db.query.holidays.findMany({
        where: and(eq(holidays.date, tomorrowDate), eq(holidays.notificationSent, false)),
        columns: { id: true },
      });

      for (const holiday of upcomingHolidays) {
        await this.db
          .update(holidays)
          .set({ notificationSent: true })
          .where(eq(holidays.id, holiday.id));
      }

      return { success: true, count: upcomingHolidays.length };
    } catch (error) {
      logger.error("Failed to send holiday notifications", error);
      return { error: "Failed to send notifications" };
    }
  }
}
