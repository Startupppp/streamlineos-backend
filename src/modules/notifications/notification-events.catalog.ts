import type {
  NotificationChannel,
  NotificationEventDefinition,
} from "./notification-event-definition.types";
import {
  IN_APP,
  IN_APP_EMAIL,
  IN_APP_PUSH,
  URGENT_ALLOWED_CHANNELS,
} from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";
import { CHAT_NOTIFICATION_EVENTS } from "./notification-events-chat.catalog";
import { BUILD_NOTIFICATION_EVENTS } from "./notification-events-build.catalog";
import { ACCOUNTING_NOTIFICATION_EVENTS } from "./notification-events-accounting.catalog";
import { HR_NOTIFICATION_EVENTS } from "./notification-events-hr.catalog";
import { OWNERSHIP_NOTIFICATION_EVENTS } from "./notification-events-ownership.catalog";
import { KNOWLEDGE_NOTIFICATION_EVENTS } from "./notification-events-knowledge.catalog";
import { SECURITY_SUPPORT_NOTIFICATION_EVENTS } from "./notification-events-security-support.catalog";
import { CRM_NOTIFICATION_EVENTS } from "./notification-events-crm.catalog";
import { INVENTORY_NOTIFICATION_EVENTS } from "./notification-events-inventory.catalog";

const e = notificationEvent;
const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;
const IA_PUSH = IN_APP_PUSH;
const ALLOWED_URGENT = URGENT_ALLOWED_CHANNELS;

const SURVEYS = [
  e(
    "survey.response.received",
    "surveys",
    "SURVEYS",
    "Survey response received",
    { defaultPriority: "LOW", defaultChannels: IA },
  ),
  e("survey.deadline.due_soon", "surveys", "SURVEYS", "Survey deadline soon", {
    defaultChannels: IA_EMAIL,
  }),
  e(
    "survey.certification.passed",
    "surveys",
    "SURVEYS",
    "Certification passed",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e(
    "survey.certification.failed",
    "surveys",
    "SURVEYS",
    "Certification failed",
    { defaultType: "WARNING", defaultChannels: IA },
  ),
  e(
    "survey.live_session.started",
    "surveys",
    "SURVEYS",
    "Live session started",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_PUSH,
      quietHoursBehavior: "bypass_if_high",
      dedupeWindowSeconds: 0,
    },
  ),
];

const CALENDAR = [
  e("calendar.event.invited", "calendar", "CALENDAR", "Event invitation", {
    defaultChannels: IA_EMAIL,
  }),
  e(
    "calendar.event.starting_soon",
    "calendar",
    "CALENDAR",
    "Event starting soon",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_PUSH,
      quietHoursBehavior: "bypass_if_high",
      dedupeWindowSeconds: 0,
    },
  ),
  e("calendar.event.changed", "calendar", "CALENDAR", "Event updated", {
    defaultChannels: IA_EMAIL,
  }),
  e("calendar.event.cancelled", "calendar", "CALENDAR", "Event cancelled", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e("calendar.reminder", "calendar", "CALENDAR", "Reminder", {
    defaultChannels: IA_PUSH,
  }),
];

const BILLING = [
  e("billing.trial.expiring", "billing", "BILLING", "Trial ending soon", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("billing.invoice.created", "billing", "BILLING", "Invoice created", {
    defaultChannels: IA_EMAIL,
  }),
  e("billing.invoice.due_soon", "billing", "BILLING", "Invoice due soon", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("billing.payment.failed", "billing", "BILLING", "Payment failed", {
    defaultPriority: "CRITICAL",
    defaultType: "ERROR",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
  }),
  e(
    "billing.subscription.changed",
    "billing",
    "BILLING",
    "Subscription changed",
    { defaultChannels: IA_EMAIL },
  ),
  e(
    "billing.subscription.cancelled",
    "billing",
    "BILLING",
    "Subscription cancelled",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      defaultChannels: IA_EMAIL,
    },
  ),
];

const BROADCAST_EMAIL: NotificationChannel[] = ["EMAIL"];
const BROADCAST_ALLOWED: NotificationChannel[] = ["EMAIL", "PUSH", "SMS", "WHATSAPP"];

const BROADCASTS = [
  e("notification.broadcast.published", "notification", "SYSTEM", "Organization announcement", {
    description: "An organization-wide broadcast was published to your audience group",
    defaultPriority: "NORMAL",
    defaultType: "INFO",
    defaultChannels: BROADCAST_EMAIL,
    allowedChannels: BROADCAST_ALLOWED,
    mandatory: false,
    userConfigurable: true,
    quietHoursBehavior: "respect",
    dedupeWindowSeconds: 0,
  }),
];

const SYSTEM = [
  e("system.weekly_recap", "system", "SYSTEM", "Weekly executive recap", {
    defaultChannels: IA_EMAIL,
    dedupeWindowSeconds: 86400,
  }),
  e("tasks.task.assigned", "tasks", "SYSTEM", "Task assigned to you", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "compliance.policy.updated",
    "system",
    "SYSTEM",
    "Compliance policy updated",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
    },
  ),
];

export const NOTIFICATION_EVENT_CATALOG = [
  ...CHAT_NOTIFICATION_EVENTS,
  ...BUILD_NOTIFICATION_EVENTS,
  ...CRM_NOTIFICATION_EVENTS,
  ...HR_NOTIFICATION_EVENTS,
  ...KNOWLEDGE_NOTIFICATION_EVENTS,
  ...SECURITY_SUPPORT_NOTIFICATION_EVENTS,
  ...OWNERSHIP_NOTIFICATION_EVENTS,
  ...ACCOUNTING_NOTIFICATION_EVENTS,
  ...INVENTORY_NOTIFICATION_EVENTS,
  ...SURVEYS,
  ...CALENDAR,
  ...BILLING,
  ...SYSTEM,
  ...BROADCASTS,
];

export type NotificationEventKey =
  (typeof NOTIFICATION_EVENT_CATALOG)[number]["eventKey"];

const EVENT_KEY_SET: ReadonlySet<string> = new Set(
  NOTIFICATION_EVENT_CATALOG.map((def) => def.eventKey),
);

export function isNotificationEventKey(
  value: string,
): value is NotificationEventKey {
  return EVENT_KEY_SET.has(value);
}

export const NOTIFICATION_EVENT_MAP: ReadonlyMap<
  string,
  NotificationEventDefinition
> = new Map(NOTIFICATION_EVENT_CATALOG.map((def) => [def.eventKey, def]));
