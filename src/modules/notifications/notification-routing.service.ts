import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, sql, or, isNull, inArray } from "drizzle-orm";
import {
  notificationPreferences,
  notificationPreferenceRules,
  notificationPolicyDefaults,
  notificationProviderAccounts,
  notificationSuppressionRules,
  notificationConsents,
  notificationDeliveries,
  organizationMembers,
  userPreferences,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { NOTIF_CACHE } from "./notification-cache-keys";
import {
  ALL_CHANNELS,
  type ChannelDecision,
  type NotificationChannel,
  type NotificationEventDefinition,
  type NotificationPriority,
  type RoutingResult,
  type SuppressionReason,
} from "./notification.types";
import {
  computeRouting,
  CONSENT_REQUIRED_CHANNELS,
  type RouteContext,
} from "./notification-routing-computation";

import {
  resolvePrefs,
  type NotificationPreferenceRuleProjection,
  type ResolvedPreferences,
} from "./notification-preference-resolution";

export { computeRouting, type RouteContext } from "./notification-routing-computation";

interface OrgPolicyResolved {
  defaultChannels: NotificationChannel[];
  eventOverride?: { channels?: string[]; muted?: boolean };
  categoryOverride?: { channels?: string[]; muted?: boolean };
  moduleOverride?: { channels?: string[]; muted?: boolean };
  canUserOverride: boolean;
}

interface CachedPolicy {
  defaultChannels: NotificationChannel[];
  eventOverrides: Record<string, { channels?: string[]; muted?: boolean }>;
  categoryOverrides: Record<string, { channels?: string[]; muted?: boolean }>;
  moduleOverrides: Record<string, { channels?: string[]; muted?: boolean }>;
  canUserOverride: boolean;
}

@Injectable()
export class NotificationRoutingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async loadOrgAvailability(orgId: string): Promise<Set<NotificationChannel>> {
    const enabled = await this.cache.cached(
      NOTIF_CACHE.availability(orgId),
      async () => {
        const rows = await this.db
          .select({ channel: notificationProviderAccounts.channel })
          .from(notificationProviderAccounts)
          .where(
            and(
              eq(notificationProviderAccounts.orgId, orgId),
              eq(notificationProviderAccounts.enabled, true),
            ),
          )
          .limit(ALL_CHANNELS.length);
        return rows.map((r) => r.channel);
      },
      CACHE_TTL.MEDIUM,
    );
    return new Set<NotificationChannel>(["IN_APP", "EMAIL", ...enabled]);
  }

  private async loadOrgPolicyData(orgId: string): Promise<CachedPolicy | null> {
    const wrapped = await this.cache.cached(
      NOTIF_CACHE.policy(orgId),
      async (): Promise<{ policy: CachedPolicy | null }> => {
        const row = await this.db.query.notificationPolicyDefaults.findFirst({
          where: and(
            eq(notificationPolicyDefaults.orgId, orgId),
            eq(notificationPolicyDefaults.scopeType, "ORG"),
            isNull(notificationPolicyDefaults.scopeId),
          ),
        });
        if (!row) return { policy: null };
        return {
          policy: {
            defaultChannels: (row.defaultChannels ?? []).filter(
              (c): c is NotificationChannel =>
                ALL_CHANNELS.includes(c as NotificationChannel),
            ),
            eventOverrides: row.eventOverrides,
            categoryOverrides: row.categoryOverrides,
            moduleOverrides: row.moduleOverrides,
            canUserOverride: row.canUserOverride,
          },
        };
      },
      CACHE_TTL.MEDIUM,
    );
    return wrapped.policy;
  }

  private async loadOrgPolicy(
    orgId: string,
    def: NotificationEventDefinition,
  ): Promise<OrgPolicyResolved | null> {
    const policy = await this.loadOrgPolicyData(orgId);
    if (!policy) return null;
    return {
      defaultChannels: policy.defaultChannels,
      eventOverride: policy.eventOverrides[def.eventKey],
      categoryOverride: policy.categoryOverrides[def.category],
      moduleOverride: policy.moduleOverrides[def.sourceModule],
      canUserOverride: policy.canUserOverride,
    };
  }

  private async loadSuppressionBatch(
    orgId: string,
    userIds: string[],
    def: NotificationEventDefinition,
  ): Promise<Map<string, Map<NotificationChannel, SuppressionReason>>> {
    const perUser = new Map<
      string,
      Map<NotificationChannel, SuppressionReason>
    >();
    for (const u of userIds) perUser.set(u, new Map());
    if (userIds.length === 0) return perUser;

    const now = new Date();
    const rows = await this.db.query.notificationSuppressionRules.findMany({
      limit: Math.max(1, userIds.length * ALL_CHANNELS.length * 6),
      where: and(
        eq(notificationSuppressionRules.orgId, orgId),
        or(
          isNull(notificationSuppressionRules.userId),
          inArray(notificationSuppressionRules.userId, userIds),
        ),
        or(
          isNull(notificationSuppressionRules.expiresAt),
          gte(notificationSuppressionRules.expiresAt, now),
        ),
        or(
          and(
            eq(notificationSuppressionRules.scopeType, "event"),
            eq(notificationSuppressionRules.scopeKey, def.eventKey),
          ),
          and(
            eq(notificationSuppressionRules.scopeType, "module"),
            eq(notificationSuppressionRules.scopeKey, def.sourceModule),
          ),
          and(
            eq(notificationSuppressionRules.scopeType, "category"),
            eq(notificationSuppressionRules.scopeKey, def.category),
          ),
          // COMP-002. The scope a one-click unsubscribe writes for
          // ALL_NON_MANDATORY: every event, not one key. Without this arm the rule
          // is stored, listed in the preferences UI and never read.
          // `computeRouting` is what keeps "non-mandatory" honest — it applies a
          // rule only when the event is not mandatory.
          and(
            eq(notificationSuppressionRules.scopeType, "all"),
            eq(notificationSuppressionRules.scopeKey, "*"),
          ),
        ),
      ),
    });
    for (const r of rows) {
      const channels = r.channel ? [r.channel] : ALL_CHANNELS;
      const applyTo = r.userId ? [r.userId] : userIds;
      for (const u of applyTo) {
        const m = perUser.get(u);
        if (!m) continue;
        for (const ch of channels)
          if (!m.has(ch)) m.set(ch, r.reason as SuppressionReason);
      }
    }
    return perUser;
  }

  /**
   * COMP-003. `notification_consents` had no reader outside the GDPR export, so
   * SMS and WhatsApp routed with no regard for whether a legal basis was ever
   * recorded. One batched query, shaped like the preference-rule fetch beside it:
   * the consent row is keyed on membership, and routing works in user ids.
   *
   * "Any GRANTED row for this channel" is the right question at routing time. The
   * destination is not known until the delivery worker resolves it, so the row's
   * `destination` is what the consent was given FOR, and the gate here is whether
   * consent exists at all. A withdrawal flips `state`, so a WITHDRAWN row does not
   * match and the channel closes again.
   */
  private async loadConsentBatch(
    orgId: string,
    userIds: string[],
  ): Promise<Map<string, Set<NotificationChannel>>> {
    const perUser = new Map<string, Set<NotificationChannel>>();
    for (const u of userIds) perUser.set(u, new Set());
    if (userIds.length === 0) return perUser;

    const rows = await this.db
      .select({
        userId: organizationMembers.userId,
        channel: notificationConsents.channel,
      })
      .from(notificationConsents)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, notificationConsents.orgId),
          eq(organizationMembers.id, notificationConsents.membershipId),
        ),
      )
      .where(
        and(
          eq(notificationConsents.orgId, orgId),
          eq(notificationConsents.state, "GRANTED"),
          inArray(notificationConsents.channel, [...CONSENT_REQUIRED_CHANNELS]),
          eq(organizationMembers.status, "ACTIVE"),
          inArray(organizationMembers.userId, userIds),
        ),
      )
      .limit(Math.max(1, userIds.length * CONSENT_REQUIRED_CHANNELS.length * 4));

    for (const row of rows) perUser.get(row.userId)?.add(row.channel);
    return perUser;
  }

  private async applyRateLimitsBatch(
    orgId: string,
    userIds: string[],
    def: NotificationEventDefinition,
    perUser: Map<string, Map<NotificationChannel, SuppressionReason>>,
  ): Promise<void> {
    if (
      def.rateLimitMax <= 0 ||
      def.rateLimitWindowSeconds <= 0 ||
      userIds.length === 0
    )
      return;
    const since = new Date(Date.now() - def.rateLimitWindowSeconds * 1000);
    const rows = await this.db
      .select({
        userId: notificationDeliveries.userId,
        channel: notificationDeliveries.channel,
        count: sql<number>`count(*)::int`,
      })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.orgId, orgId),
          inArray(notificationDeliveries.userId, userIds),
          eq(notificationDeliveries.eventKey, def.eventKey),
          gte(notificationDeliveries.createdAt, since),
          inArray(notificationDeliveries.status, [
            "SENT",
            "DELIVERED",
            "QUEUED",
            "SENDING",
            "PENDING",
          ]),
        ),
      )
      .groupBy(notificationDeliveries.userId, notificationDeliveries.channel);
    for (const r of rows) {
      if (Number(r.count) < def.rateLimitMax) continue;
      const m = perUser.get(r.userId);
      if (m && !m.has(r.channel)) m.set(r.channel, "RATE_LIMIT");
    }
  }

  /**
   * Resolve routing for many recipients of the same event in a fixed number of queries:
   * org providers + org policy once, and preferences + suppression batched — instead of
   * per-recipient round trips. Scales to large fan-out without N×queries.
   */
  async routeMany(
    orgId: string,
    userIds: string[],
    definition: NotificationEventDefinition,
    priority: NotificationPriority,
    channels?: NotificationChannel[],
  ): Promise<Map<string, RoutingResult>> {
    const results = new Map<string, RoutingResult>();
    if (userIds.length === 0) return results;

    const [availableChannels, orgPolicy, prefRows, ruleRows, tzRows] =
      await Promise.all([
        this.loadOrgAvailability(orgId),
        this.loadOrgPolicy(orgId, definition),
        this.db
          .select({
            userId: notificationPreferences.userId,
            inAppEnabled: notificationPreferences.inAppEnabled,
            emailEnabled: notificationPreferences.emailEnabled,
            pushEnabled: notificationPreferences.pushEnabled,
            smsEnabled: notificationPreferences.smsEnabled,
            whatsappEnabled: notificationPreferences.whatsappEnabled,
            quietHoursStart: notificationPreferences.quietHoursStart,
            quietHoursEnd: notificationPreferences.quietHoursEnd,
            quietHoursWeekends: notificationPreferences.quietHoursWeekends,
            allowCriticalOverride:
              notificationPreferences.allowCriticalOverride,
          })
          .from(notificationPreferences)
          .where(
            and(
              eq(notificationPreferences.orgId, orgId),
              inArray(notificationPreferences.userId, userIds),
            ),
          )
          .limit(userIds.length),
        // SCH-003: the normalised replacement for the four JSONB preference blobs.
        this.db
          .select({
            userId: organizationMembers.userId,
            rule: {
              scopeType: notificationPreferenceRules.scopeType,
              scopeKey: notificationPreferenceRules.scopeKey,
              channel: notificationPreferenceRules.channel,
              mode: notificationPreferenceRules.mode,
            },
          })
          .from(notificationPreferenceRules)
          .innerJoin(
            organizationMembers,
            and(
              eq(organizationMembers.orgId, notificationPreferenceRules.orgId),
              eq(
                organizationMembers.id,
                notificationPreferenceRules.membershipId,
              ),
            ),
          )
          .where(
            and(
              eq(notificationPreferenceRules.orgId, orgId),
              eq(organizationMembers.status, "ACTIVE"),
              inArray(organizationMembers.userId, userIds),
              or(
                and(
                  eq(notificationPreferenceRules.scopeType, "EVENT"),
                  eq(notificationPreferenceRules.scopeKey, definition.eventKey),
                ),
                and(
                  eq(notificationPreferenceRules.scopeType, "MODULE"),
                  eq(
                    notificationPreferenceRules.scopeKey,
                    definition.sourceModule,
                  ),
                ),
                and(
                  eq(notificationPreferenceRules.scopeType, "CATEGORY"),
                  eq(notificationPreferenceRules.scopeKey, definition.category),
                ),
              ),
            ),
          )
          .limit(Math.max(1, userIds.length * ALL_CHANNELS.length * 3)),
        // SCH-012: quiet hours resolve from the canonical per-user timezone.
        // notification_preferences.quiet_hours_timezone defaulted 'UTC' while this
        // column defaults 'Asia/Kolkata', so an IST user's 22:00-07:00 window was
        // applied in UTC — silencing the working day and letting the night through.
        this.db
          .select({
            userId: userPreferences.userId,
            timezone: userPreferences.timezone,
          })
          .from(userPreferences)
          .where(inArray(userPreferences.userId, userIds))
          .limit(userIds.length),
      ]);
    const prefsByUser = new Map(prefRows.map((r) => [r.userId, r]));
    const rulesByUser = new Map<
      string,
      Array<(typeof ruleRows)[number]["rule"]>
    >();
    for (const row of ruleRows) {
      const bucket = rulesByUser.get(row.userId);
      if (bucket) bucket.push(row.rule);
      else rulesByUser.set(row.userId, [row.rule]);
    }
    const tzByUser = new Map(tzRows.map((r) => [r.userId, r.timezone]));
    const routingDefinition = channels
      ? { ...definition, defaultChannels: channels, allowedChannels: channels }
      : definition;
    const [suppressionByUser, consentByUser] = await Promise.all([
      this.loadSuppressionBatch(orgId, userIds, routingDefinition),
      this.loadConsentBatch(orgId, userIds),
    ]);
    await this.applyRateLimitsBatch(
      orgId,
      userIds,
      routingDefinition,
      suppressionByUser,
    );

    const now = new Date();
    for (const userId of userIds) {
      const result = computeRouting({
        definition: routingDefinition,
        priority,
        now,
        prefs: resolvePrefs(
          prefsByUser.get(userId),
          tzByUser.get(userId),
          rulesByUser.get(userId) ?? [],
        ),
        orgPolicy,
        availableChannels,
        suppressedChannels: suppressionByUser.get(userId) ?? new Map(),
        consentedChannels: consentByUser.get(userId) ?? new Set(),
      });
      results.set(userId, { ...result, userId });
    }
    return results;
  }

  async route(
    orgId: string,
    userId: string,
    definition: NotificationEventDefinition,
    priority: NotificationPriority,
  ): Promise<RoutingResult> {
    const results = await this.routeMany(orgId, [userId], definition, priority);
    return (
      results.get(userId) ?? {
        userId,
        createInApp: true,
        channels: [],
        priority,
        deferredUntil: null,
        reasonText: "",
      }
    );
  }
}
