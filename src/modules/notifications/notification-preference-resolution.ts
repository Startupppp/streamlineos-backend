import type { notificationPreferences } from "../../db/schema";
import type { NotificationChannel } from "./notification.types";
import type { QuietHoursConfig } from "./quiet-hours.util";

/**
 * Folding a member's stored preference rows into the single shape the routing
 * computation consumes.
 *
 * Pure, and separate from `NotificationRoutingService` because it is the one
 * step of routing that reads no table and calls no cache: it takes the header
 * row, the timezone and the per-scope rules already loaded and returns the
 * resolved view. That makes the precedence — a category is on unless a channel
 * rule turns it off, an event is muted only when every channel it names is off —
 * checkable without a database.
 */

export interface ResolvedPreferences {
  channelEnabled: Record<NotificationChannel, boolean>;
  quietHours: QuietHoursConfig;
  categories: Record<string, boolean>;
  modulePreferences: Record<string, { mode?: string; muted?: boolean }>;
  eventPreferences: Record<
    string,
    { channels?: Record<string, boolean>; muted?: boolean; mode?: string }
  >;
  allowCriticalOverride: boolean;
}

export type NotificationPreferenceRuleProjection = {
  scopeType: "EVENT" | "MODULE" | "CATEGORY";
  scopeKey: string;
  channel: NotificationChannel;
  mode: "ON" | "OFF" | "DIGEST";
};

/**
 * SCH-003. `computeRouting` is correct and spec-covered, so its input shape is
 * unchanged; only the source moved. Per-event, per-module and per-category settings
 * now come from `notification_preference_rules` instead of four JSONB blobs on the
 * header row. The header still carries the channel toggles, quiet hours and digest
 * mode, which are genuinely one-per-user and not lifecycle state.
 */
export function resolvePrefs(
  row: Partial<Pick<
    typeof notificationPreferences.$inferSelect,
    | "inAppEnabled"
    | "emailEnabled"
    | "pushEnabled"
    | "smsEnabled"
    | "whatsappEnabled"
    | "quietHoursStart"
    | "quietHoursEnd"
    | "quietHoursWeekends"
    | "allowCriticalOverride"
  >> | undefined,
  userTimezone: string | undefined,
  rules: NotificationPreferenceRuleProjection[],
): ResolvedPreferences {
  const eventPreferences: ResolvedPreferences["eventPreferences"] = {};
  const modulePreferences: ResolvedPreferences["modulePreferences"] = {};
  const categories: Record<string, boolean> = {};

  for (const rule of rules) {
    const on = rule.mode !== "OFF";
    if (rule.scopeType === "EVENT") {
      const entry = (eventPreferences[rule.scopeKey] ??= { channels: {} });
      (entry.channels ??= {})[rule.channel] = on;
      // Muted only when every channel the user has an opinion about is off.
      entry.muted = Object.values(entry.channels).every((v) => v === false);
    } else if (rule.scopeType === "MODULE") {
      const entry = (modulePreferences[rule.scopeKey] ??= {});
      if (!on) entry.muted = true;
    } else if (rule.scopeType === "CATEGORY") {
      // A category is on unless some channel rule turns it off.
      categories[rule.scopeKey] = (categories[rule.scopeKey] ?? true) && on;
    }
  }

  const channelEnabled: Record<NotificationChannel, boolean> = {
    IN_APP: row?.inAppEnabled ?? true,
    EMAIL: row?.emailEnabled ?? true,
    PUSH: row?.pushEnabled ?? true,
    SMS: row?.smsEnabled ?? false,
    WHATSAPP: row?.whatsappEnabled ?? false,
    WEBHOOK: true,
  };
  return {
    channelEnabled,
    quietHours: {
      start: row?.quietHoursStart ?? null,
      end: row?.quietHoursEnd ?? null,
      timezone: userTimezone ?? "UTC",
      includeWeekends: row?.quietHoursWeekends ?? true,
    },
    categories,
    modulePreferences,
    eventPreferences,
    allowCriticalOverride: row?.allowCriticalOverride ?? true,
  };
}
