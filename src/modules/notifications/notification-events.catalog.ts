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

const e = notificationEvent;
const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;
const IA_PUSH = IN_APP_PUSH;
const ALLOWED_URGENT = URGENT_ALLOWED_CHANNELS;

const CRM = [
  e("crm.lead.assigned", "crm", "CRM", "Lead assigned to you", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
    rateLimitWindowSeconds: 3600,
    rateLimitMax: 50,
  }),
  e("crm.lead.created", "crm", "CRM", "New lead created", {
    defaultChannels: IA,
    rateLimitWindowSeconds: 3600,
    rateLimitMax: 100,
  }),
  e("crm.deal.stage_changed", "crm", "CRM", "Deal stage changed", {
    defaultChannels: IA,
  }),
  e("crm.followup.due", "crm", "CRM", "Follow-up due", {
    defaultChannels: IA_EMAIL,
    ttlSeconds: 86400,
    rateLimitWindowSeconds: 86400,
    rateLimitMax: 50,
  }),
  e("crm.followup.overdue", "crm", "CRM", "Follow-up overdue", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "crm.customer.message_received",
    "crm",
    "CRM",
    "Customer message received",
    { defaultPriority: "HIGH", defaultChannels: IA_PUSH },
  ),
  e("crm.automation.failed", "crm", "CRM", "Automation failed", {
    defaultPriority: "HIGH",
    defaultType: "ERROR",
    defaultChannels: IA_EMAIL,
  }),
  e("crm.lead.converted", "crm", "CRM", "Lead converted to client", {
    defaultType: "SUCCESS",
    defaultChannels: IA_PUSH,
  }),
  e("crm.client.assigned", "crm", "CRM", "New client assigned to you", {
    defaultPriority: "HIGH",
    defaultChannels: IA_PUSH,
  }),
  e("crm.ai.score_ready", "crm", "AI", "AI lead score generated", {
    defaultChannels: IA,
  }),
];

const INVENTORY = [
  e("inventory.stock.low", "inventory", "INVENTORY", "Low stock", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("inventory.stock.out", "inventory", "INVENTORY", "Out of stock", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "inventory.reorder.suggested",
    "inventory",
    "INVENTORY",
    "Reorder suggested",
    { defaultChannels: IA },
  ),
  e(
    "inventory.transfer.requested",
    "inventory",
    "INVENTORY",
    "Transfer requested",
    { defaultChannels: IA },
  ),
  e(
    "inventory.transfer.completed",
    "inventory",
    "INVENTORY",
    "Transfer completed",
    { defaultType: "SUCCESS", defaultChannels: IA },
  ),
  e(
    "inventory.adjustment.approval_requested",
    "inventory",
    "WORKFLOW",
    "Adjustment approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  /**
   * E7. Raised when an outbound webhook has failed every attempt across the whole
   * retry window, while it is still enabled — the warning that precedes this
   * module disabling a customer's integration for them.
   *
   * Email as well as in-app, because the audience for "your integration stopped
   * working" is not reliably looking at the product when it happens, and the
   * whole point of the alert is that it lands before the disable does.
   */
  e("inventory.webhook.failing", "inventory", "INVENTORY", "Webhook delivery failing", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  /**
   * G3. A lot that has entered a near-expiry window and still holds stock.
   *
   * In-app only, and not urgent: a lot ninety days out is a planning signal, and
   * emailing about it is how a category gets muted before the thirty-day one
   * arrives. The narrowing windows do the escalating, not the channel.
   */
  e("inventory.lot.expiring", "inventory", "INVENTORY", "Lot nearing expiry", {
    defaultType: "WARNING",
    defaultChannels: IA,
  }),
  /**
   * G3. A recall has been opened, and stock has stopped moving.
   *
   * The one inventory event that is urgent by its nature: the goods are already
   * quarantined and the lots already refused by the allocator, so this is the
   * message that tells a warehouse why. Email as well as in-app for the same
   * reason `inventory.webhook.failing` carries it — the audience is not reliably
   * looking at the product when it happens.
   */
  e("inventory.recall.opened", "inventory", "INVENTORY", "Recall opened", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
  }),
];

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

/**
 * Timesheet reminders.
 *
 * `category` is PROJECTS, not a new TIMESHEETS value. The category is a
 * Postgres enum shared with several modules, and `ALTER TYPE ... ADD VALUE`
 * cannot run inside a transaction — which is how every migration here runs. A
 * cosmetic grouping is not worth that operational edge, and attribution is not
 * lost: `sourceModule` says "timesheets" and that is what the settings UI
 * groups by.
 *
 * Both are user-configurable and neither is mandatory. A reminder is a
 * courtesy; someone who has turned them off has said something and should be
 * believed.
 */
const TIMESHEETS = [
  e("timesheets.period.due_soon", "timesheets", "PROJECTS", "Timesheet due soon", {
    description: "A timesheet period is approaching its submission deadline and has not been submitted.",
    defaultChannels: IA_EMAIL,
    /**
     * A day. The sweep is idempotent per period per day by dedupe key, but the
     * cron may be invoked more than once a day and the window is the second
     * line of defence — 60 seconds would let an hourly cron send 24 times.
     */
    dedupeWindowSeconds: 86_400,
  }),
  e("timesheets.period.overdue", "timesheets", "PROJECTS", "Timesheet overdue", {
    description: "A timesheet period has passed its submission deadline and has not been submitted.",
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
    dedupeWindowSeconds: 86_400,
  }),
  /**
   * TS-24. The three transitions somebody is waiting on.
   *
   * All `IA_EMAIL`, because the point of the ticket is the email leg: an
   * approver who is not in the product when a timesheet lands, and a worker
   * whose week was rejected, both need to hear about it somewhere other than a
   * bell icon they are not looking at. `EMAIL` routes through
   * `NotificationDispatchService` to the existing SMTP provider and the
   * existing `notification_outbox` — no new vendor and no second mailer, which
   * is the other half of the ticket.
   *
   * `dedupeWindowSeconds` stays at the 60-second default rather than the
   * reminders' day. A period really can be submitted, rejected, resubmitted and
   * approved inside an afternoon, and swallowing the second decision because it
   * resembled the first would be worse than a duplicate.
   */
  e("timesheets.period.submitted", "timesheets", "PROJECTS", "Timesheet submitted for approval", {
    description: "A team member submitted a timesheet period and it is waiting for your approval.",
    defaultChannels: IA_EMAIL,
  }),
  e("timesheets.period.approved", "timesheets", "PROJECTS", "Timesheet approved", {
    description: "Your submitted timesheet period was approved.",
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e("timesheets.period.rejected", "timesheets", "PROJECTS", "Timesheet rejected", {
    description: "Your submitted timesheet period was rejected and needs changes.",
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
] as const;

export const NOTIFICATION_EVENT_CATALOG = [
  ...CHAT_NOTIFICATION_EVENTS,
  ...BUILD_NOTIFICATION_EVENTS,
  ...CRM,
  ...HR_NOTIFICATION_EVENTS,
  ...KNOWLEDGE_NOTIFICATION_EVENTS,
  ...SECURITY_SUPPORT_NOTIFICATION_EVENTS,
  ...OWNERSHIP_NOTIFICATION_EVENTS,
  ...ACCOUNTING_NOTIFICATION_EVENTS,
  ...INVENTORY,
  ...SURVEYS,
  ...CALENDAR,
  ...BILLING,
  ...TIMESHEETS,
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
