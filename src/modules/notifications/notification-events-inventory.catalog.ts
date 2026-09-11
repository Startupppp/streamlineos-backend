import { IN_APP, IN_APP_EMAIL, URGENT_ALLOWED_CHANNELS } from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";
import type { NotificationEventDefinition } from "./notification-event-definition.types";

const e = notificationEvent;
const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;
const ALLOWED_URGENT = URGENT_ALLOWED_CHANNELS;

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
