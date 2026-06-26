import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { notificationPreferences } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpdateNotificationPreferencesInput } from "./dto/notification-preferences.schemas";

@Injectable()
export class HrNotificationPreferencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(userId: string) {
    const prefs = await this.db.query.notificationPreferences.findFirst({
      where: eq(notificationPreferences.userId, userId),
    });

    if (!prefs) {
      return {
        emailEnabled: true,
        pushEnabled: true,
        smsEnabled: false,
        inAppEnabled: true,
        quietHoursStart: null,
        quietHoursEnd: null,
        categories: {},
      };
    }

    return {
      emailEnabled: prefs.emailEnabled,
      pushEnabled: prefs.pushEnabled,
      smsEnabled: prefs.smsEnabled,
      inAppEnabled: prefs.inAppEnabled,
      quietHoursStart: prefs.quietHoursStart,
      quietHoursEnd: prefs.quietHoursEnd,
      categories: prefs.categories,
    };
  }

  async update(userId: string, orgId: string, data: UpdateNotificationPreferencesInput) {
    const existing = await this.db.query.notificationPreferences.findFirst({
      where: eq(notificationPreferences.userId, userId),
    });

    if (existing) {
      await this.db
        .update(notificationPreferences)
        .set({
          emailEnabled: data.emailEnabled,
          pushEnabled: data.pushEnabled,
          smsEnabled: data.smsEnabled,
          inAppEnabled: data.inAppEnabled,
          quietHoursStart: data.quietHoursStart,
          quietHoursEnd: data.quietHoursEnd,
          categories: data.categories,
          updatedAt: new Date(),
        })
        .where(eq(notificationPreferences.userId, userId));
    } else {
      await this.db.insert(notificationPreferences).values({
        userId,
        orgId,
        emailEnabled: data.emailEnabled,
        pushEnabled: data.pushEnabled,
        smsEnabled: data.smsEnabled,
        inAppEnabled: data.inAppEnabled,
        quietHoursStart: data.quietHoursStart,
        quietHoursEnd: data.quietHoursEnd,
        categories: data.categories,
      });
    }

    return { success: true };
  }
}
