import type { NotificationChannel, NotificationEventDefinition } from "./notification-event-definition.types";
import type { NotificationCategoryValue } from "./notifications.types";
import {
  DEFAULT_ALLOWED_CHANNELS,
  IN_APP,
} from "./notification-event-channel-policy";

type EventOverrides = Partial<Omit<NotificationEventDefinition, "eventKey" | "sourceModule" | "category" | "displayName">>;

export function notificationEvent<K extends string>(
  eventKey: K,
  sourceModule: string,
  category: NotificationCategoryValue,
  displayName: string,
  overrides: EventOverrides = {},
): NotificationEventDefinition & { eventKey: K } {
  return {
    eventKey,
    sourceModule,
    category,
    displayName,
    description: overrides.description ?? displayName,
    defaultPriority: overrides.defaultPriority ?? "NORMAL",
    defaultType: overrides.defaultType ?? "INFO",
    defaultChannels: overrides.defaultChannels ?? IN_APP,
    allowedChannels: overrides.allowedChannels ?? DEFAULT_ALLOWED_CHANNELS,
    mandatory: overrides.mandatory ?? false,
    userConfigurable: overrides.userConfigurable ?? true,
    adminConfigurable: overrides.adminConfigurable ?? true,
    quietHoursBehavior: overrides.quietHoursBehavior ?? "respect",
    dedupeWindowSeconds: overrides.dedupeWindowSeconds ?? 60,
    rateLimitWindowSeconds: overrides.rateLimitWindowSeconds ?? 0,
    rateLimitMax: overrides.rateLimitMax ?? 0,
    templateKey: overrides.templateKey,
    audienceResolver: overrides.audienceResolver,
    visibilityResourceKind: overrides.visibilityResourceKind,
    ttlSeconds: overrides.ttlSeconds,
  };
}

export type { EventOverrides };
