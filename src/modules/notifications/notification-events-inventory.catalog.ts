import { IN_APP, IN_APP_EMAIL } from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";
import type { NotificationEventDefinition } from "./notification-event-definition.types";

const e = notificationEvent;
const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;

export const INVENTORY_NOTIFICATION_EVENTS: NotificationEventDefinition[] = [
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
];
