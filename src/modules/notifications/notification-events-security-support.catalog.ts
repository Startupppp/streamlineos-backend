import {
  IN_APP,
  IN_APP_EMAIL,
  IN_APP_PUSH,
  URGENT_ALLOWED_CHANNELS,
} from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";

const e = notificationEvent;
const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;
const IA_PUSH = IN_APP_PUSH;
const ALLOWED_URGENT = URGENT_ALLOWED_CHANNELS;

export const SECURITY_SUPPORT_NOTIFICATION_EVENTS = [
  e("security.login.new_device", "security", "SECURITY", "New device sign-in", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
  }),
  e("security.mfa.disabled", "security", "SECURITY", "Two-factor disabled", {
    defaultPriority: "CRITICAL",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
  }),
  e(
    "security.role.changed",
    "security",
    "SECURITY",
    "Role or permissions changed",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
    },
  ),
  e("security.api_key.created", "security", "SECURITY", "API key created", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
    allowedChannels: ALLOWED_URGENT,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "always_bypass",
  }),
  e(
    "security.suspicious_activity",
    "security",
    "SECURITY",
    "Suspicious activity detected",
    {
      defaultPriority: "CRITICAL",
      defaultType: "ERROR",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
    },
  ),
  e("support.ticket.assigned", "support", "SUPPORT", "Ticket assigned to you", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("support.ticket.updated", "support", "SUPPORT", "Support ticket updated", {
    defaultChannels: IA_EMAIL,
  }),
  e(
    "support.ticket.customer_replied",
    "support",
    "SUPPORT",
    "Customer replied",
    { defaultPriority: "HIGH", defaultChannels: IA_PUSH },
  ),
  e("support.ticket.sla_breached", "support", "SUPPORT", "SLA breached", {
    defaultPriority: "CRITICAL",
    defaultType: "ERROR",
    defaultChannels: IA_EMAIL,
    quietHoursBehavior: "bypass_if_high",
  }),
  e("support.ticket.escalated", "support", "SUPPORT", "Ticket escalated", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
  e(
    "support.ticket.mention",
    "support",
    "SUPPORT",
    "Mentioned in an internal note",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_PUSH,
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "support.kb.gap.routed",
    "support",
    "SUPPORT",
    "KB gap article needs review",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      description:
        "A draft KB article generated from a recurring support question needs human review before publishing",
    },
  ),
];
