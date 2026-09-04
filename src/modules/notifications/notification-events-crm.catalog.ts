import { IN_APP, IN_APP_EMAIL, IN_APP_PUSH } from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";
import type { NotificationEventDefinition } from "./notification-event-definition.types";

const e = notificationEvent;
const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;
const IA_PUSH = IN_APP_PUSH;

export const CRM_NOTIFICATION_EVENTS: NotificationEventDefinition[] = [
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
