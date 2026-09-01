import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, isNull, desc, or } from "drizzle-orm";
import { notificationPreferences, notificationPolicyDefaults, notificationAuditLogs, notificationPreferenceRules, notificationSuppressionRules } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpdatePreferenceInput, EventPreferenceInput, CreateSuppressionInput } from "./dto/preference.schemas";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { ALL_CHANNELS, type NotificationChannel } from "./notification.types";

type EventPrefMap = Record<string, { channels?: Record<string, boolean>; muted?: boolean; mode?: string }>;

const DEFAULT_PREFERENCES = {
  emailEnabled: true,
  pushEnabled: true,
  smsEnabled: false,
  whatsappEnabled: false,
  inAppEnabled: true,
  soundEnabled: true,
  quietHoursStart: null as string | null,
  quietHoursEnd: null as string | null,
  quietHoursWeekends: true,
  allowCriticalOverride: true,
  digestMode: "disabled" as "disabled" | "hourly" | "daily" | "weekly",
  categories: {} as Record<string, boolean>,
  channelCategories: {} as Record<string, Record<string, boolean>>,
  eventPreferences: {} as EventPrefMap,
  modulePreferences: {} as Record<string, { mode?: string; muted?: boolean }>,
};

function isNotificationChannel(value: string): value is NotificationChannel {
  return (ALL_CHANNELS as readonly string[]).includes(value);
}

@Injectable()
export class NotificationPreferencesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: NotificationEventRegistryService,
  ) {}

  private memberPredicate(userId: string, membershipId: number | null | undefined) {
    if (membershipId != null)
      return or(
        eq(notificationPreferences.membershipId, membershipId),
        and(isNull(notificationPreferences.membershipId), eq(notificationPreferences.userId, userId)),
      );
    return eq(notificationPreferences.userId, userId);
  }

  async get(orgId: string, userId: string, membershipId?: number | null) {
    const existing = await this.db.query.notificationPreferences.findFirst({
      where: and(eq(notificationPreferences.orgId, orgId), this.memberPredicate(userId, membershipId)),
    });
    return existing ?? { ...DEFAULT_PREFERENCES, userId, orgId };
  }

  async getEffective(orgId: string, userId: string, membershipId?: number | null) {
    const [prefs, orgPolicy] = await Promise.all([
      this.get(orgId, userId, membershipId),
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

  async update(orgId: string, userId: string, dto: UpdatePreferenceInput, membershipId?: number | null) {
    const provided = <K extends keyof UpdatePreferenceInput>(key: K) => dto[key] !== undefined;

    const insertValues = { ...DEFAULT_PREFERENCES, userId, orgId, membershipId: membershipId ?? null, updatedBy: userId, ...dto };
    const updateSet: Record<string, unknown> = { updatedAt: new Date(), updatedBy: userId };
    for (const key of Object.keys(dto) as Array<keyof UpdatePreferenceInput>) {
      if (provided(key)) updateSet[key] = dto[key];
    }

    const [result] = await this.db
      .insert(notificationPreferences)
      .values(insertValues)
      .onConflictDoUpdate({ target: notificationPreferences.userId, set: updateSet })
      .returning();

    // SCH-003 write cutover. Routing resolves mutes and category switches from
    // `notification_preference_rules` ONLY — the JSONB columns below are no longer read.
    // Without this projection the preference centre would still write, still show the
    // toggle as saved, and change nothing about what actually gets sent.
    await this.projectToRules(orgId, userId, dto, membershipId);

    await this.audit(orgId, userId, "preference.updated", { fields: Object.keys(dto) });
    return result;
  }

  /**
   * Translates the JSONB preference shapes the UI submits into rule rows.
   *
   * A rule row means "the user has an opinion"; absence means "fall through to the
   * defaults", which is why an ON state deletes rather than storing a row — persisting
   * the default would make a later change to that default silently not apply.
   *
   * The JSONB columns are still written by the caller above: this is the expand half of
   * expand-contract, so a rollback of the read path still finds its data intact.
   */
  private async projectToRules(
    orgId: string,
    userId: string,
    dto: UpdatePreferenceInput,
    membershipId?: number | null,
  ): Promise<void> {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const writes: Array<{
      scopeType: "EVENT" | "MODULE" | "CATEGORY";
      scopeKey: string;
      channel: NotificationChannel;
      on: boolean;
    }> = [];

    if (dto.categories) {
      for (const [category, on] of Object.entries(dto.categories))
        for (const channel of ALL_CHANNELS)
          writes.push({ scopeType: "CATEGORY", scopeKey: category, channel, on: on !== false });
    }

    if (dto.modulePreferences) {
      for (const [module, pref] of Object.entries(dto.modulePreferences))
        for (const channel of ALL_CHANNELS)
          writes.push({ scopeType: "MODULE", scopeKey: module, channel, on: pref?.muted !== true });
    }

    if (dto.eventPreferences) {
      for (const [eventKey, pref] of Object.entries(dto.eventPreferences)) {
        // An explicit per-channel map wins; a bare `muted` applies to every channel.
        const channels = pref?.channels;
        if (channels && Object.keys(channels).length > 0) {
          for (const [channel, on] of Object.entries(channels)) {
            // The JSONB map is free-form, so a stale or misspelled channel key must not
            // become a rule row the routing layer will never match.
            if (!isNotificationChannel(channel)) continue;
            writes.push({ scopeType: "EVENT", scopeKey: eventKey, channel, on: on !== false });
          }
        } else {
          for (const channel of ALL_CHANNELS)
            writes.push({ scopeType: "EVENT", scopeKey: eventKey, channel, on: pref?.muted !== true });
        }
      }
    }

    if (writes.length === 0) return;

    const off = writes.filter((w) => !w.on);
    const on = writes.filter((w) => w.on);

    for (const w of on) {
      await this.db
        .delete(notificationPreferenceRules)
        .where(
          and(
            eq(notificationPreferenceRules.orgId, orgId),
            eq(notificationPreferenceRules.membershipId, membershipId),
            eq(notificationPreferenceRules.scopeType, w.scopeType),
            eq(notificationPreferenceRules.scopeKey, w.scopeKey),
            eq(notificationPreferenceRules.channel, w.channel),
          ),
        );
    }

    if (off.length > 0) {
      await this.db
        .insert(notificationPreferenceRules)
        .values(
          off.map((w) => ({
            orgId,
            membershipId,
            scopeType: w.scopeType,
            scopeKey: w.scopeKey,
            channel: w.channel,
            mode: "OFF" as const,
            updatedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [
            notificationPreferenceRules.orgId,
            notificationPreferenceRules.membershipId,
            notificationPreferenceRules.scopeType,
            notificationPreferenceRules.scopeKey,
            notificationPreferenceRules.channel,
          ],
          set: { mode: "OFF", updatedAt: new Date() },
        });
    }
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

  async updateEventPreference(orgId: string, userId: string, eventKey: string, pref: EventPreferenceInput, membershipId?: number | null) {
    this.registry.assertKnown(eventKey);
    const current = await this.get(orgId, userId, membershipId);
    const eventPrefs: EventPrefMap = { ...((current.eventPreferences as EventPrefMap) ?? {}) };
    eventPrefs[eventKey] = { ...eventPrefs[eventKey], ...pref };
    const result = await this.update(orgId, userId, { eventPreferences: eventPrefs }, membershipId);
    return result;
  }

  async reset(orgId: string, userId: string, membershipId?: number | null) {
    await this.db
      .delete(notificationPreferences)
      .where(and(eq(notificationPreferences.orgId, orgId), this.memberPredicate(userId, membershipId)));
    await this.audit(orgId, userId, "preference.reset");
    return { ...DEFAULT_PREFERENCES, userId, orgId };
  }

  listSuppressions(orgId: string, userId: string) {
    return this.db
      .select({
        id: notificationSuppressionRules.id,
        scopeType: notificationSuppressionRules.scopeType,
        scopeKey: notificationSuppressionRules.scopeKey,
        channel: notificationSuppressionRules.channel,
        reason: notificationSuppressionRules.reason,
        expiresAt: notificationSuppressionRules.expiresAt,
        createdAt: notificationSuppressionRules.createdAt,
      })
      .from(notificationSuppressionRules)
      .where(and(eq(notificationSuppressionRules.orgId, orgId), eq(notificationSuppressionRules.userId, userId)))
      .orderBy(desc(notificationSuppressionRules.createdAt))
      .limit(100);
  }

  async createSuppression(orgId: string, userId: string, dto: CreateSuppressionInput) {
    const [row] = await this.db
      .insert(notificationSuppressionRules)
      .values({
        orgId,
        userId,
        scopeType: dto.scopeType,
        scopeKey: dto.scopeKey,
        channel: dto.channel ?? null,
        reason: "MUTE",
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdBy: userId,
      })
      .returning();
    await this.audit(orgId, userId, "suppression.created", { scopeType: dto.scopeType, scopeKey: dto.scopeKey });
    return row;
  }

  async removeSuppression(orgId: string, userId: string, id: number) {
    const [existing] = await this.db
      .select({ id: notificationSuppressionRules.id })
      .from(notificationSuppressionRules)
      .where(
        and(
          eq(notificationSuppressionRules.id, id),
          eq(notificationSuppressionRules.orgId, orgId),
          eq(notificationSuppressionRules.userId, userId),
        ),
      );
    if (!existing) throw new NotFoundException("Suppression rule not found");
    await this.db.delete(notificationSuppressionRules).where(eq(notificationSuppressionRules.id, id));
    await this.audit(orgId, userId, "suppression.removed", { id });
    return { success: true };
  }
}
