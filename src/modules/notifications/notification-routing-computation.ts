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

export interface RouteContext {
  definition: NotificationEventDefinition;
  priority: NotificationPriority;
  now: Date;
  prefs: {
    channelEnabled: Record<NotificationChannel, boolean>;
    quietHours: QuietHoursConfig;
    categories: Record<string, boolean>;
    modulePreferences: Record<string, { mode?: string; muted?: boolean }>;
    eventPreferences: Record<string, { channels?: Record<string, boolean>; muted?: boolean; mode?: string }>;
    allowCriticalOverride: boolean;
  };
  orgPolicy: {
    defaultChannels: NotificationChannel[];
    eventOverride?: { channels?: string[]; muted?: boolean };
    categoryOverride?: { channels?: string[]; muted?: boolean };
    moduleOverride?: { channels?: string[]; muted?: boolean };
    canUserOverride: boolean;
  } | null;
  availableChannels: Set<NotificationChannel>;
  suppressedChannels: Map<NotificationChannel, SuppressionReason>;
  /**
   * COMP-003. The channels this recipient has a GRANTED `notification_consents`
   * row for. Absent means absent: an empty set suppresses every consent-gated
   * channel, which is the only safe default for a legal basis.
   */
  consentedChannels: Set<NotificationChannel>;
}

/**
 * COMP-003. `notification_consents`, `notification_consent_events` and the
 * `CONSENT_MISSING` suppression reason were all declared, migrated and read by
 * nobody but the GDPR export adapter — which therefore exported an empty list.
 * SMS and WhatsApp routed on preferences, org policy and suppression rules alone,
 * so a channel that legally cannot ship without a recorded agreement shipped on a
 * toggle. These two are the channels that gate; EMAIL and PUSH do not, because
 * unsubscribe (`notification_suppression_rules`) is their governing mechanism and
 * a browser push subscription is itself the grant.
 */
export const CONSENT_REQUIRED_CHANNELS = ["SMS", "WHATSAPP"] as const;

export function requiresConsent(channel: NotificationChannel): boolean {
  return CONSENT_REQUIRED_CHANNELS.some((c) => c === channel);
}

const PRIORITY_RANK: Record<NotificationPriority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 };
const FALLBACK_CHAIN: Partial<Record<NotificationChannel, NotificationChannel>> = {
  WHATSAPP: "SMS", SMS: "EMAIL", PUSH: "EMAIL", EMAIL: "IN_APP",
};

function isHigh(priority: NotificationPriority): boolean {
  return PRIORITY_RANK[priority] >= PRIORITY_RANK.HIGH;
}

export function computeRouting(ctx: RouteContext): RoutingResult {
  const { definition, priority, prefs, orgPolicy, availableChannels, suppressedChannels } = ctx;
  const consented = ctx.consentedChannels ?? new Set<NotificationChannel>();
  const mandatory = definition.mandatory;
  const allowed = new Set<NotificationChannel>(definition.allowedChannels);
  allowed.add("IN_APP");
  let candidates: NotificationChannel[];
  if (orgPolicy?.eventOverride?.channels?.length) candidates = orgPolicy.eventOverride.channels.filter((c): c is NotificationChannel => ALL_CHANNELS.some((channel) => channel === c));
  else if (orgPolicy?.categoryOverride?.channels?.length) candidates = orgPolicy.categoryOverride.channels.filter((c): c is NotificationChannel => ALL_CHANNELS.some((channel) => channel === c));
  else if (orgPolicy?.moduleOverride?.channels?.length) candidates = orgPolicy.moduleOverride.channels.filter((c): c is NotificationChannel => ALL_CHANNELS.some((channel) => channel === c));
  else if (orgPolicy?.defaultChannels?.length) candidates = orgPolicy.defaultChannels;
  else candidates = definition.defaultChannels;
  candidates = Array.from(new Set<NotificationChannel>([...candidates].filter((c) => allowed.has(c))));
  if (!candidates.includes("IN_APP")) candidates.unshift("IN_APP");

  /**
   * `can_user_override: false` used to bind only the per-event channel map, so an
   * admin who turned it off still could not reach anyone: the reader's global
   * channel switch, their category/module mute and their own suppression rules all
   * still suppressed delivery. The narrow gate made the policy look enforced while
   * every coarser personal control walked straight past it.
   *
   * The org's OWN mute (`eventOverride.muted`) is deliberately outside the gate —
   * it is the policy speaking, not the reader overriding it — and consent and
   * provider availability stay absolute below, because neither is a preference.
   */
  const canUserOverride = orgPolicy?.canUserOverride ?? true;
  const orgMuted = orgPolicy?.eventOverride?.muted === true;
  const personalMuted =
    prefs.eventPreferences[definition.eventKey]?.muted === true ||
    prefs.modulePreferences[definition.sourceModule]?.muted === true ||
    prefs.categories[definition.category] === false;
  const userMuted = !mandatory && (orgMuted || (canUserOverride && personalMuted));
  const eventPrefChannels = prefs.eventPreferences[definition.eventKey]?.channels;
  const decisions: ChannelDecision[] = [];
  const sending = new Set<NotificationChannel>();
  const suppress = (channel: NotificationChannel, reason: SuppressionReason, detail?: string): void => {
    if (!decisions.some((d) => d.channel === channel)) decisions.push({ channel, action: "SUPPRESS", reason, detail });
  };
  const send = (channel: NotificationChannel): void => {
    if (!sending.has(channel)) { sending.add(channel); decisions.push({ channel, action: "SEND" }); }
  };

  for (const channel of candidates) {
    const isInApp = channel === "IN_APP";
    // Consent is checked before every other gate, and it binds a mandatory event
    // too. A mandatory alert does not create a legal basis to text somebody; what
    // it does create is an obligation to reach them, and FALLBACK_CHAIN below
    // carries WHATSAPP -> SMS -> EMAIL -> IN_APP for exactly that.
    if (requiresConsent(channel) && !consented.has(channel)) {
      suppress(channel, "CONSENT_MISSING", "No recorded consent for this channel");
      continue;
    }
    if (userMuted && !isInApp) { suppress(channel, "MUTE", "Muted by preference"); continue; }
    if (eventPrefChannels && canUserOverride && !mandatory && eventPrefChannels[channel] === false) { suppress(channel, "CHANNEL_DISABLED", "Disabled for this event"); continue; }
    if (canUserOverride && !prefs.channelEnabled[channel] && !(mandatory && !isInApp)) { if (!mandatory) { suppress(channel, "CHANNEL_DISABLED", "Channel turned off"); continue; } }
    const ruleReason = suppressedChannels.get(channel);
    if (ruleReason && !mandatory && canUserOverride) { suppress(channel, ruleReason, "Suppression rule"); continue; }
    if (!availableChannels.has(channel)) { suppress(channel, "NO_PROVIDER", "No provider configured"); continue; }
    send(channel);
  }

  if (mandatory) {
    const hasExternalSend = [...sending].some((c) => c !== "IN_APP");
    if (!hasExternalSend) {
      const blocked = decisions.filter((d) => d.action === "SUPPRESS" && d.channel !== "IN_APP");
      for (const b of blocked) {
        let fallback = FALLBACK_CHAIN[b.channel];
        while (fallback && fallback !== "IN_APP") {
          const consentOk = !requiresConsent(fallback) || consented.has(fallback);
          if (consentOk && allowed.has(fallback) && availableChannels.has(fallback) && !sending.has(fallback)) { send(fallback); break; }
          fallback = FALLBACK_CHAIN[fallback];
        }
      }
    }
    if (!sending.has("IN_APP")) send("IN_APP");
  }
  const createInApp = sending.has("IN_APP") || (prefs.channelEnabled.IN_APP && !userMuted) || mandatory;
  if (createInApp && !sending.has("IN_APP")) send("IN_APP");
  let deferredUntil: Date | null = null;
  const criticalBypass = priority === "CRITICAL" && prefs.allowCriticalOverride;
  const shouldConsiderQuiet = !mandatory && definition.quietHoursBehavior !== "always_bypass" && !criticalBypass && !(definition.quietHoursBehavior === "bypass_if_high" && isHigh(priority));
  if (shouldConsiderQuiet && isWithinQuietHours(ctx.now, prefs.quietHours)) {
    if ([...sending].some((c) => c !== "IN_APP")) deferredUntil = quietHoursEndAt(ctx.now, prefs.quietHours);
  }
  const sentChannels = [...sending];
  const externalSent = sentChannels.filter((c) => c !== "IN_APP");
  const reasonParts: string[] = [`You received "${definition.displayName}"`];
  if (mandatory) reasonParts.push("This is a required security or compliance alert and cannot be muted.");
  if (externalSent.length) reasonParts.push(`Delivered via ${sentChannels.join(", ")}${deferredUntil ? " (external channels held until quiet hours end)" : ""}.`);
  else if (sentChannels.includes("IN_APP")) reasonParts.push("Shown in your in-app inbox.");
  return { userId: "", createInApp, channels: decisions, priority, deferredUntil, reasonText: reasonParts.join(" ") };
}
