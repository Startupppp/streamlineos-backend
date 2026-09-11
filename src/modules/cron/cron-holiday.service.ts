import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { holidays } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { forEachOrg } from "../../common/tenant";

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
      let count = 0;

      await forEachOrg(this.db, "send-holiday-notifications", async (tx, orgId) => {
        const upcomingHolidays = await tx
          .select({ id: holidays.id })
          .from(holidays)
          .where(
            and(
              eq(holidays.orgId, orgId),
              eq(holidays.date, tomorrowDate),
              eq(holidays.notificationSent, false),
            ),
          );

        if (upcomingHolidays.length > 0)
          await tx
            .update(holidays)
            .set({ notificationSent: true })
            .where(
              and(
                eq(holidays.orgId, orgId),
                inArray(holidays.id, upcomingHolidays.map((holiday) => holiday.id)),
              ),
            );

        count += upcomingHolidays.length;
      });

      return { success: true, count };
    } catch (error) {
      logger.error("Failed to send holiday notifications", error);
      return { error: "Failed to send notifications" };
    }
  }
}
