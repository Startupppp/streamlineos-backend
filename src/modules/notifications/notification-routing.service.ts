import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, sql, or, isNull, inArray } from "drizzle-orm";
import {
  notificationPreferences,
  notificationPolicyDefaults,
  notificationProviderAccounts,
  notificationSuppressionRules,
  notificationDeliveries,
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
import { isWithinQuietHours, quietHoursEndAt, type QuietHoursConfig } from "./quiet-hours.util";

interface ResolvedPreferences {
  channelEnabled: Record<NotificationChannel, boolean>;
  quietHours: QuietHoursConfig;
  categories: Record<string, boolean>;
  modulePreferences: Record<string, { mode?: string; muted?: boolean }>;
  eventPreferences: Record<string, { channels?: Record<string, boolean>; muted?: boolean; mode?: string }>;
  allowCriticalOverride: boolean;
}

interface OrgPolicyResolved {
  defaultChannels: NotificationChannel[];
  eventOverride?: { channels?: string[]; muted?: boolean };
  categoryOverride?: { channels?: string[]; muted?: boolean };
  moduleOverride?: { channels?: string[]; muted?: boolean };
  canUserOverride: boolean;
}

export interface RouteContext {
  definition: NotificationEventDefinition;
  priority: NotificationPriority;
  now: Date;
  prefs: ResolvedPreferences;
  orgPolicy: OrgPolicyResolved | null;
  availableChannels: Set<NotificationChannel>;
  suppressedChannels: Map<NotificationChannel, SuppressionReason>;
}

const PRIORITY_RANK: Record<NotificationPriority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 };

const FALLBACK_CHAIN: Partial<Record<NotificationChannel, NotificationChannel>> = {
  WHATSAPP: "SMS",
  SMS: "EMAIL",
  PUSH: "EMAIL",
  TEAMS: "EMAIL",
  SLACK: "EMAIL",
  EMAIL: "IN_APP",
};

function isHigh(priority: NotificationPriority): boolean {
  return PRIORITY_RANK[priority] >= PRIORITY_RANK.HIGH;
}

export function computeRouting(ctx: RouteContext): RoutingResult {
  const { definition, priority, prefs, orgPolicy, availableChannels, suppressedChannels } = ctx;
  const mandatory = definition.mandatory;

  const allowed = new Set<NotificationChannel>(definition.allowedChannels);
  allowed.add("IN_APP");

  let candidates: NotificationChannel[];
  if (orgPolicy?.eventOverride?.channels?.length) {
    candidates = orgPolicy.eventOverride.channels.filter((c): c is NotificationChannel => ALL_CHANNELS.includes(c as NotificationChannel));
  } else if (orgPolicy?.categoryOverride?.channels?.length) {
    candidates = orgPolicy.categoryOverride.channels.filter((c): c is NotificationChannel => ALL_CHANNELS.includes(c as NotificationChannel));
  } else if (orgPolicy?.moduleOverride?.channels?.length) {
    candidates = orgPolicy.moduleOverride.channels.filter((c): c is NotificationChannel => ALL_CHANNELS.includes(c as NotificationChannel));
  } else if (orgPolicy?.defaultChannels?.length) {
    candidates = orgPolicy.defaultChannels;
  } else {
    candidates = definition.defaultChannels;
  }
  candidates = Array.from(new Set<NotificationChannel>([...candidates].filter((c) => allowed.has(c))));
  if (!candidates.includes("IN_APP")) candidates.unshift("IN_APP");

  const userMuted =
    !mandatory &&
    (prefs.eventPreferences[definition.eventKey]?.muted === true ||
      prefs.modulePreferences[definition.sourceModule]?.muted === true ||
      prefs.categories[definition.category] === false ||
      orgPolicy?.eventOverride?.muted === true);

  const eventPrefChannels = prefs.eventPreferences[definition.eventKey]?.channels;
  const canUserOverride = orgPolicy?.canUserOverride ?? true;

  const decisions: ChannelDecision[] = [];
  const sending = new Set<NotificationChannel>();

  const suppress = (channel: NotificationChannel, reason: SuppressionReason, detail?: string): void => {
    if (decisions.some((d) => d.channel === channel)) return;
    decisions.push({ channel, action: "SUPPRESS", reason, detail });
  };
  const send = (channel: NotificationChannel): void => {
    if (sending.has(channel)) return;
    sending.add(channel);
    decisions.push({ channel, action: "SEND" });
  };

  for (const channel of candidates) {
    const isInApp = channel === "IN_APP";

    if (userMuted && !isInApp) {
      suppress(channel, "MUTE", "Muted by preference");
      continue;
    }
    if (eventPrefChannels && canUserOverride && !mandatory && eventPrefChannels[channel] === false) {
      suppress(channel, "CHANNEL_DISABLED", "Disabled for this event");
      continue;
    }
    if (!prefs.channelEnabled[channel] && !(mandatory && !isInApp)) {
      if (!mandatory) {
        suppress(channel, "CHANNEL_DISABLED", "Channel turned off");
        continue;
      }
    }
    const ruleReason = suppressedChannels.get(channel);
    if (ruleReason && !mandatory) {
      suppress(channel, ruleReason, "Suppression rule");
      continue;
    }
    if (!availableChannels.has(channel)) {
      suppress(channel, "NO_PROVIDER", "No provider configured");
      continue;
    }
    send(channel);
  }

  // Fallback chain for mandatory events whose primary external channels were blocked.
  if (mandatory) {
    const hasExternalSend = [...sending].some((c) => c !== "IN_APP");
    if (!hasExternalSend) {
      const blocked = decisions.filter((d) => d.action === "SUPPRESS" && d.channel !== "IN_APP");
      for (const b of blocked) {
        let fallback = FALLBACK_CHAIN[b.channel];
        while (fallback && fallback !== "IN_APP") {
          if (allowed.has(fallback) && availableChannels.has(fallback) && !sending.has(fallback)) {
            send(fallback);
            break;
          }
          fallback = FALLBACK_CHAIN[fallback];
        }
      }
    }
    if (!sending.has("IN_APP")) send("IN_APP");
  }

  const createInApp = sending.has("IN_APP") || (prefs.channelEnabled.IN_APP && !userMuted) || mandatory;
  if (createInApp && !sending.has("IN_APP")) send("IN_APP");

  // Quiet hours defer external channels (in-app is always immediate).
  let deferredUntil: Date | null = null;
  const behavior = definition.quietHoursBehavior;
  const criticalBypass = priority === "CRITICAL" && prefs.allowCriticalOverride;
  const shouldConsiderQuiet =
    !mandatory && behavior !== "always_bypass" && !criticalBypass && !(behavior === "bypass_if_high" && isHigh(priority));
  if (shouldConsiderQuiet && isWithinQuietHours(ctx.now, prefs.quietHours)) {
    const hasExternal = [...sending].some((c) => c !== "IN_APP");
    if (hasExternal) deferredUntil = quietHoursEndAt(ctx.now, prefs.quietHours);
  }

  const sentChannels = [...sending];
  const externalSent = sentChannels.filter((c) => c !== "IN_APP");
  const reasonParts: string[] = [`You received "${definition.displayName}"`];
  if (mandatory) reasonParts.push("This is a required security or compliance alert and cannot be muted.");
  if (externalSent.length) {
    reasonParts.push(`Delivered via ${sentChannels.join(", ")}${deferredUntil ? " (external channels held until quiet hours end)" : ""}.`);
  } else if (sentChannels.includes("IN_APP")) {
    reasonParts.push("Shown in your in-app inbox.");
  }

  return {
    userId: "",
    createInApp,
    channels: decisions,
    priority,
    deferredUntil,
    reasonText: reasonParts.join(" "),
  };
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
          .where(and(eq(notificationProviderAccounts.orgId, orgId), eq(notificationProviderAccounts.enabled, true)));
        return rows.map((r) => r.channel);
      },
      CACHE_TTL.MEDIUM,
    );
    return new Set<NotificationChannel>(["IN_APP", "EMAIL", ...enabled]);
  }

  private resolvePrefs(row: typeof notificationPreferences.$inferSelect | undefined): ResolvedPreferences {
    const channelEnabled: Record<NotificationChannel, boolean> = {
      IN_APP: row?.inAppEnabled ?? true,
      EMAIL: row?.emailEnabled ?? true,
      PUSH: row?.pushEnabled ?? true,
      SMS: row?.smsEnabled ?? false,
      WHATSAPP: row?.whatsappEnabled ?? false,
      SLACK: row?.slackEnabled ?? false,
      TEAMS: row?.teamsEnabled ?? false,
      WEBHOOK: true,
    };
    return {
      channelEnabled,
      quietHours: {
        start: row?.quietHoursStart ?? null,
        end: row?.quietHoursEnd ?? null,
        timezone: row?.quietHoursTimezone ?? "UTC",
        includeWeekends: row?.quietHoursWeekends ?? true,
      },
      categories: (row?.categories as Record<string, boolean> | undefined) ?? {},
      modulePreferences: (row?.modulePreferences as ResolvedPreferences["modulePreferences"] | undefined) ?? {},
      eventPreferences: (row?.eventPreferences as ResolvedPreferences["eventPreferences"] | undefined) ?? {},
      allowCriticalOverride: row?.allowCriticalOverride ?? true,
    };
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
            defaultChannels: (row.defaultChannels ?? []).filter((c): c is NotificationChannel => ALL_CHANNELS.includes(c as NotificationChannel)),
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

  private async loadOrgPolicy(orgId: string, def: NotificationEventDefinition): Promise<OrgPolicyResolved | null> {
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
    const perUser = new Map<string, Map<NotificationChannel, SuppressionReason>>();
    for (const u of userIds) perUser.set(u, new Map());
    if (userIds.length === 0) return perUser;

    const now = new Date();
    const rows = await this.db.query.notificationSuppressionRules.findMany({
      where: and(
        eq(notificationSuppressionRules.orgId, orgId),
        or(isNull(notificationSuppressionRules.userId), inArray(notificationSuppressionRules.userId, userIds)),
        or(isNull(notificationSuppressionRules.expiresAt), gte(notificationSuppressionRules.expiresAt, now)),
        or(
          and(eq(notificationSuppressionRules.scopeType, "event"), eq(notificationSuppressionRules.scopeKey, def.eventKey)),
          and(eq(notificationSuppressionRules.scopeType, "module"), eq(notificationSuppressionRules.scopeKey, def.sourceModule)),
          and(eq(notificationSuppressionRules.scopeType, "category"), eq(notificationSuppressionRules.scopeKey, def.category)),
        ),
      ),
    });
    for (const r of rows) {
      const channels = r.channel ? [r.channel] : ALL_CHANNELS;
      const applyTo = r.userId ? [r.userId] : userIds;
      for (const u of applyTo) {
        const m = perUser.get(u);
        if (!m) continue;
        for (const ch of channels) if (!m.has(ch)) m.set(ch, r.reason as SuppressionReason);
      }
    }
    return perUser;
  }

  private async applyRateLimitsBatch(
    orgId: string,
    userIds: string[],
    def: NotificationEventDefinition,
    perUser: Map<string, Map<NotificationChannel, SuppressionReason>>,
  ): Promise<void> {
    if (def.rateLimitMax <= 0 || def.rateLimitWindowSeconds <= 0 || userIds.length === 0) return;
    const since = new Date(Date.now() - def.rateLimitWindowSeconds * 1000);
    const rows = await this.db
      .select({ userId: notificationDeliveries.userId, channel: notificationDeliveries.channel, count: sql<number>`count(*)::int` })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.orgId, orgId),
          inArray(notificationDeliveries.userId, userIds),
          eq(notificationDeliveries.eventKey, def.eventKey),
          gte(notificationDeliveries.createdAt, since),
          inArray(notificationDeliveries.status, ["SENT", "DELIVERED", "QUEUED", "SENDING", "PENDING"]),
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
  ): Promise<Map<string, RoutingResult>> {
    const results = new Map<string, RoutingResult>();
    if (userIds.length === 0) return results;

    const [availableChannels, orgPolicy, prefRows] = await Promise.all([
      this.loadOrgAvailability(orgId),
      this.loadOrgPolicy(orgId, definition),
      this.db
        .select()
        .from(notificationPreferences)
        .where(and(eq(notificationPreferences.orgId, orgId), inArray(notificationPreferences.userId, userIds))),
    ]);
    const prefsByUser = new Map(prefRows.map((r) => [r.userId, r]));
    const suppressionByUser = await this.loadSuppressionBatch(orgId, userIds, definition);
    await this.applyRateLimitsBatch(orgId, userIds, definition, suppressionByUser);

    const now = new Date();
    for (const userId of userIds) {
      const result = computeRouting({
        definition,
        priority,
        now,
        prefs: this.resolvePrefs(prefsByUser.get(userId)),
        orgPolicy,
        availableChannels,
        suppressedChannels: suppressionByUser.get(userId) ?? new Map(),
      });
      results.set(userId, { ...result, userId });
    }
    return results;
  }

  async route(orgId: string, userId: string, definition: NotificationEventDefinition, priority: NotificationPriority): Promise<RoutingResult> {
    const results = await this.routeMany(orgId, [userId], definition, priority);
    return results.get(userId) ?? { userId, createInApp: true, channels: [], priority, deferredUntil: null, reasonText: "" };
  }
}
