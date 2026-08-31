import {
  IN_APP_EMAIL,
  URGENT_ALLOWED_CHANNELS,
} from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";

const e = notificationEvent;
const IA_EMAIL = IN_APP_EMAIL;
const ALLOWED_URGENT = URGENT_ALLOWED_CHANNELS;

export const OWNERSHIP_NOTIFICATION_EVENTS = [
  e(
    "ownership.transfer.requested",
    "ownership",
    "SECURITY",
    "Ownership transfer requested",
    {
      description:
        "You have been nominated to take over an organization or module ownership",
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.transfer.accepted",
    "ownership",
    "SECURITY",
    "Ownership transfer accepted",
    {
      description:
        "An ownership transfer was accepted and control has changed hands",
      defaultPriority: "HIGH",
      defaultType: "SUCCESS",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.transfer.declined",
    "ownership",
    "SECURITY",
    "Ownership transfer declined",
    {
      defaultPriority: "HIGH",
      defaultType: "WARNING",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.transfer.cancelled",
    "ownership",
    "SECURITY",
    "Ownership transfer cancelled",
    {
      defaultType: "WARNING",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.transfer.expired",
    "ownership",
    "SECURITY",
    "Ownership transfer expired",
    {
      defaultType: "WARNING",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "ownership.module_owner.changed",
    "ownership",
    "SECURITY",
    "Module ownership changed",
    {
      description: "You gained or lost lifecycle ownership of a module",
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "organization.setup.completed",
    "organization",
    "SYSTEM",
    "Organization setup completed",
    { defaultChannels: IA_EMAIL },
  ),
  e(
    "organization.invitation.accepted",
    "organization",
    "SECURITY",
    "Invitation accepted",
    {
      description: "Someone you invited accepted and joined the organization",
      defaultType: "SUCCESS",
    },
  ),
  e(
    "organization.invitation.declined",
    "organization",
    "SECURITY",
    "Invitation declined",
    {
      description: "Someone you invited declined the invitation",
      defaultType: "WARNING",
    },
  ),
  e(
    "organization.invitation.expired",
    "organization",
    "SECURITY",
    "Invitation expired",
    {
      description: "An invitation you sent expired before it was accepted",
      defaultType: "WARNING",
    },
  ),
  e(
    "organization.member.reactivated",
    "organization",
    "SECURITY",
    "Your access was restored",
    {
      description: "Your membership in an organization was reactivated",
      defaultPriority: "HIGH",
      defaultType: "SUCCESS",
      defaultChannels: IA_EMAIL,
      allowedChannels: ALLOWED_URGENT,
      mandatory: true,
      userConfigurable: false,
      quietHoursBehavior: "always_bypass",
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "organization.member.left",
    "organization",
    "SECURITY",
    "Member left the organization",
    {
      defaultType: "WARNING",
    },
  ),
];
