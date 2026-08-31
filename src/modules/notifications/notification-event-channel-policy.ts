import type { NotificationChannel } from "./notification-event-definition.types";

export const IN_APP: NotificationChannel[] = ["IN_APP"];
export const IN_APP_EMAIL: NotificationChannel[] = ["IN_APP", "EMAIL"];
export const IN_APP_PUSH: NotificationChannel[] = ["IN_APP", "PUSH"];
export const IN_APP_PUSH_EMAIL: NotificationChannel[] = ["IN_APP", "PUSH", "EMAIL"];
export const DEFAULT_ALLOWED_CHANNELS: NotificationChannel[] = ["IN_APP", "EMAIL", "PUSH"];
export const URGENT_ALLOWED_CHANNELS: NotificationChannel[] = [
  "IN_APP",
  "EMAIL",
  "PUSH",
  "SMS",
  "WHATSAPP",
];

export const KNOWLEDGE_PAGE_RESOURCE = "kb.page";
export const BUILD_TICKET_RESOURCE = "build.ticket";
