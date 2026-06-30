import { Inject, Injectable } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { notificationPreferences } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpdatePreferenceInput } from "./dto/preference.schemas";

const DEFAULT_PREFERENCES = {
  emailEnabled: true,
  pushEnabled: true,
  smsEnabled: false,
  inAppEnabled: true,
  slackEnabled: false,
  teamsEnabled: false,
  whatsappEnabled: false,
  soundEnabled: true,
  quietHoursStart: null as string | null,
  quietHoursEnd: null as string | null,
  quietHoursTimezone: "UTC",
  digestMode: "disabled" as "disabled" | "hourly" | "daily" | "weekly",
  categories: {} as Record<string, boolean>,
  channelCategories: {} as Record<string, Record<string, boolean>>,
};

@Injectable()
export class NotificationPreferencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(orgId: string, userId: string) {
    const existing = await this.db.query.notificationPreferences.findFirst({
      where: and(
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.orgId, orgId),
      ),
    });
    return existing ?? { ...DEFAULT_PREFERENCES, userId, orgId };
  }

  async update(orgId: string, userId: string, dto: UpdatePreferenceInput) {
    const insertValues = {
      userId,
      orgId,
      emailEnabled: dto.emailEnabled ?? true,
      pushEnabled: dto.pushEnabled ?? true,
      smsEnabled: dto.smsEnabled ?? false,
      inAppEnabled: dto.inAppEnabled ?? true,
      slackEnabled: dto.slackEnabled ?? false,
      teamsEnabled: dto.teamsEnabled ?? false,
      whatsappEnabled: dto.whatsappEnabled ?? false,
      soundEnabled: dto.soundEnabled ?? true,
      quietHoursStart: dto.quietHoursStart ?? null,
      quietHoursEnd: dto.quietHoursEnd ?? null,
      quietHoursTimezone: dto.quietHoursTimezone ?? "UTC",
      digestMode: (dto.digestMode ?? "disabled") as "disabled" | "hourly" | "daily" | "weekly",
      categories: (dto.categories ?? {}) as Record<string, boolean>,
      channelCategories: (dto.channelCategories ?? {}) as Record<string, Record<string, boolean>>,
    };

    const updateSet = {
      updatedAt: new Date(),
      ...(dto.emailEnabled !== undefined && { emailEnabled: dto.emailEnabled }),
      ...(dto.pushEnabled !== undefined && { pushEnabled: dto.pushEnabled }),
      ...(dto.smsEnabled !== undefined && { smsEnabled: dto.smsEnabled }),
      ...(dto.inAppEnabled !== undefined && { inAppEnabled: dto.inAppEnabled }),
      ...(dto.slackEnabled !== undefined && { slackEnabled: dto.slackEnabled }),
      ...(dto.teamsEnabled !== undefined && { teamsEnabled: dto.teamsEnabled }),
      ...(dto.whatsappEnabled !== undefined && { whatsappEnabled: dto.whatsappEnabled }),
      ...(dto.soundEnabled !== undefined && { soundEnabled: dto.soundEnabled }),
      ...(dto.quietHoursStart !== undefined && { quietHoursStart: dto.quietHoursStart }),
      ...(dto.quietHoursEnd !== undefined && { quietHoursEnd: dto.quietHoursEnd }),
      ...(dto.quietHoursTimezone !== undefined && { quietHoursTimezone: dto.quietHoursTimezone }),
      ...(dto.digestMode !== undefined && { digestMode: dto.digestMode as "disabled" | "hourly" | "daily" | "weekly" }),
      ...(dto.categories !== undefined && { categories: dto.categories as Record<string, boolean> }),
      ...(dto.channelCategories !== undefined && { channelCategories: dto.channelCategories as Record<string, Record<string, boolean>> }),
    };

    const [result] = await this.db
      .insert(notificationPreferences)
      .values(insertValues)
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: updateSet,
      })
      .returning();
    return result;
  }
}
