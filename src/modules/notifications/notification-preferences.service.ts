import { Inject, Injectable } from "@nestjs/common";
import { eq, and, isNull } from "drizzle-orm";
import { notificationPreferences, notificationPolicyDefaults, notificationAuditLogs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpdatePreferenceInput, EventPreferenceInput } from "./dto/preference.schemas";
import { NotificationEventRegistryService } from "./notification-event-registry.service";

type EventPrefMap = Record<string, { channels?: Record<string, boolean>; muted?: boolean; mode?: string }>;

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
  quietHoursWeekends: true,
  allowCriticalOverride: true,
  digestMode: "disabled" as "disabled" | "hourly" | "daily" | "weekly",
  digestChannel: "EMAIL",
  digestTime: null as string | null,
  categories: {} as Record<string, boolean>,
  channelCategories: {} as Record<string, Record<string, boolean>>,
  eventPreferences: {} as EventPrefMap,
  modulePreferences: {} as Record<string, { mode?: string; muted?: boolean }>,
  priorityPreferences: {} as Record<string, { channels?: Record<string, boolean> }>,
};

@Injectable()
export class NotificationPreferencesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: NotificationEventRegistryService,
  ) {}

  async get(orgId: string, userId: string) {
    const existing = await this.db.query.notificationPreferences.findFirst({
      where: and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.orgId, orgId)),
    });
    return existing ?? { ...DEFAULT_PREFERENCES, userId, orgId };
  }

  async getEffective(orgId: string, userId: string) {
    const [prefs, orgPolicy] = await Promise.all([
      this.get(orgId, userId),
      this.db.query.notificationPolicyDefaults.findFirst({
        where: and(eq(notificationPolicyDefaults.orgId, orgId), eq(notificationPolicyDefaults.scopeType, "ORG"), isNull(notificationPolicyDefaults.scopeId)),
      }),
    ]);
    return {
      ...prefs,
      inherited: {
        defaultChannels: (orgPolicy?.defaultChannels as string[] | undefined) ?? [],
        canUserOverride: orgPolicy?.canUserOverride ?? true,
      },
    };
  }

  private async audit(orgId: string, userId: string, action: string, metadata?: Record<string, unknown>) {
    await this.db.insert(notificationAuditLogs).values({
      orgId,
      actorId: userId,
      action,
      metadata: { entityType: "preference", ...metadata },
    });
  }

  async update(orgId: string, userId: string, dto: UpdatePreferenceInput) {
    const provided = <K extends keyof UpdatePreferenceInput>(key: K) => dto[key] !== undefined;

    const insertValues = { ...DEFAULT_PREFERENCES, userId, orgId, updatedBy: userId, ...dto };
    const updateSet: Record<string, unknown> = { updatedAt: new Date(), updatedBy: userId };
    for (const key of Object.keys(dto) as Array<keyof UpdatePreferenceInput>) {
      if (provided(key)) updateSet[key] = dto[key];
    }

    const [result] = await this.db
      .insert(notificationPreferences)
      .values(insertValues)
      .onConflictDoUpdate({ target: notificationPreferences.userId, set: updateSet })
      .returning();
    await this.audit(orgId, userId, "preference.updated", { fields: Object.keys(dto) });
    return result;
  }

  async getEventCatalog(orgId: string, userId: string) {
    const [events, prefs] = await Promise.all([this.registry.listForOrg(orgId), this.get(orgId, userId)]);
    const eventPrefs = (prefs.eventPreferences as EventPrefMap) ?? {};
    return events
      .filter((e) => e.userConfigurable || e.mandatory)
      .map((e) => ({
        eventKey: e.eventKey,
        displayName: e.displayName,
        description: e.description,
        category: e.category,
        sourceModule: e.sourceModule,
        priority: e.defaultPriority,
        defaultChannels: e.defaultChannels,
        allowedChannels: e.allowedChannels,
        mandatory: e.mandatory,
        userConfigurable: e.userConfigurable,
        userPreference: eventPrefs[e.eventKey] ?? null,
      }));
  }

  async updateEventPreference(orgId: string, userId: string, eventKey: string, pref: EventPreferenceInput) {
    this.registry.assertKnown(eventKey);
    const current = await this.get(orgId, userId);
    const eventPrefs: EventPrefMap = { ...((current.eventPreferences as EventPrefMap) ?? {}) };
    eventPrefs[eventKey] = { ...eventPrefs[eventKey], ...pref };
    const result = await this.update(orgId, userId, { eventPreferences: eventPrefs });
    return result;
  }

  async reset(orgId: string, userId: string) {
    await this.db
      .delete(notificationPreferences)
      .where(and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.orgId, orgId)));
    await this.audit(orgId, userId, "preference.reset");
    return { ...DEFAULT_PREFERENCES, userId, orgId };
  }
}
