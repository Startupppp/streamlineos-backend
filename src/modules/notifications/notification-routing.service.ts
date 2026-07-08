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
    candidates = orgPolicy.eventOverride.channels as NotificationChannel[];
  } else if (orgPolicy?.categoryOverride?.channels?.length) {
    candidates = orgPolicy.categoryOverride.channels as NotificationChannel[];
  } else if (orgPolicy?.moduleOverride?.channels?.length) {
    candidates = orgPolicy.moduleOverride.channels as NotificationChannel[];
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

@Injectable()
export class NotificationRoutingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async loadOrgAvailability(orgId: string): Promise<Set<NotificationChannel>> {
    const available = new Set<NotificationChannel>(["IN_APP", "EMAIL"]);
    const rows = await this.db
      .select({ channel: notificationProviderAccounts.channel })
      .from(notificationProviderAccounts)
      .where(and(eq(notificationProviderAccounts.orgId, orgId), eq(notificationProviderAccounts.enabled, true)));
    for (const r of rows) available.add(r.channel as NotificationChannel);
    return available;
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

  private async loadOrgPolicy(orgId: string, def: NotificationEventDefinition): Promise<OrgPolicyResolved | null> {
    const row = await this.db.query.notificationPolicyDefaults.findFirst({
      where: and(eq(notificationPolicyDefaults.orgId, orgId), eq(notificationPolicyDefaults.scopeType, "ORG")),
    });
    if (!row) return null;
    const eventOverrides = (row.eventOverrides as Record<string, { channels?: string[]; muted?: boolean }>) ?? {};
    const categoryOverrides = (row.categoryOverrides as Record<string, { channels?: string[]; muted?: boolean }>) ?? {};
    const moduleOverrides = (row.moduleOverrides as Record<string, { channels?: string[]; muted?: boolean }>) ?? {};
    return {
      defaultChannels: (row.defaultChannels as NotificationChannel[]) ?? [],
      eventOverride: eventOverrides[def.eventKey],
      categoryOverride: categoryOverrides[def.category],
      moduleOverride: moduleOverrides[def.sourceModule],
      canUserOverride: row.canUserOverride,
    };
  }

  private async loadSuppression(orgId: string, userId: string, def: NotificationEventDefinition): Promise<Map<NotificationChannel, SuppressionReason>> {
    const map = new Map<NotificationChannel, SuppressionReason>();
    const now = new Date();
    const rows = await this.db.query.notificationSuppressionRules.findMany({
      where: and(
        eq(notificationSuppressionRules.orgId, orgId),
        or(isNull(notificationSuppressionRules.userId), eq(notificationSuppressionRules.userId, userId)),
        or(isNull(notificationSuppressionRules.expiresAt), gte(notificationSuppressionRules.expiresAt, now)),
      ),
    });
    const scopeMatches = (scopeType: string, scopeKey: string): boolean => {
      if (scopeType === "event") return scopeKey === def.eventKey;
      if (scopeType === "module") return scopeKey === def.sourceModule;
      if (scopeType === "category") return scopeKey === def.category;
      return false;
    };
    for (const r of rows) {
      if (!scopeMatches(r.scopeType, r.scopeKey)) continue;
      const channels = r.channel ? [r.channel as NotificationChannel] : ALL_CHANNELS;
      for (const ch of channels) if (!map.has(ch)) map.set(ch, r.reason as SuppressionReason);
    }
    return map;
  }

  private async applyRateLimits(orgId: string, userId: string, def: NotificationEventDefinition, suppressed: Map<NotificationChannel, SuppressionReason>): Promise<void> {
    if (def.rateLimitMax <= 0 || def.rateLimitWindowSeconds <= 0) return;
    const since = new Date(Date.now() - def.rateLimitWindowSeconds * 1000);
    const rows = await this.db
      .select({ channel: notificationDeliveries.channel, count: sql<number>`count(*)::int` })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.orgId, orgId),
          eq(notificationDeliveries.userId, userId),
          eq(notificationDeliveries.eventKey, def.eventKey),
          gte(notificationDeliveries.createdAt, since),
          inArray(notificationDeliveries.status, ["SENT", "DELIVERED", "QUEUED", "SENDING", "PENDING"]),
        ),
      )
      .groupBy(notificationDeliveries.channel);
    for (const r of rows) {
      if (Number(r.count) >= def.rateLimitMax && !suppressed.has(r.channel as NotificationChannel)) {
        suppressed.set(r.channel as NotificationChannel, "RATE_LIMIT");
      }
    }
  }

  async route(orgId: string, userId: string, definition: NotificationEventDefinition, priority: NotificationPriority): Promise<RoutingResult> {
    const [prefRow, availableChannels, orgPolicy] = await Promise.all([
      this.db.query.notificationPreferences.findFirst({
        where: and(eq(notificationPreferences.orgId, orgId), eq(notificationPreferences.userId, userId)),
      }),
      this.loadOrgAvailability(orgId),
      this.loadOrgPolicy(orgId, definition),
    ]);
    const suppressedChannels = await this.loadSuppression(orgId, userId, definition);
    await this.applyRateLimits(orgId, userId, definition, suppressedChannels);

    const result = computeRouting({
      definition,
      priority,
      now: new Date(),
      prefs: this.resolvePrefs(prefRow),
      orgPolicy,
      availableChannels,
      suppressedChannels,
    });
    return { ...result, userId };
  }
}
