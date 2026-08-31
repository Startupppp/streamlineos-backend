import { NOTIFICATION_EVENT_CATALOG } from "./notification-events.catalog";

const eventKeys = NOTIFICATION_EVENT_CATALOG.map((event) => event.eventKey);

export const MENTION_EVENT_KEYS: readonly string[] = eventKeys.filter((key) =>
  key.includes("mention"),
);

export const ASSIGNED_EVENT_KEYS: readonly string[] = eventKeys.filter((key) =>
  key.includes("assigned"),
);
