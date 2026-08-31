import { IN_APP_EMAIL, IN_APP_PUSH, IN_APP_PUSH_EMAIL } from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";

export const CHAT_NOTIFICATION_EVENTS = [
  notificationEvent("chat.message.direct", "chat", "CHAT", "Direct message", {
    defaultChannels: IN_APP_PUSH,
    dedupeWindowSeconds: 0,
    ttlSeconds: 3600,
    rateLimitWindowSeconds: 3600,
    rateLimitMax: 60,
  }),
  notificationEvent("chat.message.mention", "chat", "CHAT", "You were mentioned", {
    defaultPriority: "HIGH",
    defaultChannels: IN_APP_PUSH_EMAIL,
    dedupeWindowSeconds: 0,
    ttlSeconds: 3600,
    rateLimitWindowSeconds: 3600,
    rateLimitMax: 60,
  }),
  notificationEvent("chat.thread.reply", "chat", "CHAT", "New thread reply", {
    defaultChannels: IN_APP_PUSH,
    ttlSeconds: 3600,
    rateLimitWindowSeconds: 3600,
    rateLimitMax: 60,
  }),
  notificationEvent("chat.channel.invited", "chat", "CHAT", "Added to a channel", {
    defaultChannels: IN_APP_EMAIL,
  }),
  notificationEvent("chat.huddle.invite", "chat", "CHAT", "Huddle invitation", {
    defaultPriority: "HIGH",
    defaultChannels: IN_APP_PUSH,
    quietHoursBehavior: "bypass_if_high",
    dedupeWindowSeconds: 0,
    ttlSeconds: 300,
  }),
  notificationEvent("chat.reply.reminder", "chat", "CHAT", "Reply reminder", {
    defaultChannels: IN_APP_EMAIL,
    ttlSeconds: 3600,
    rateLimitWindowSeconds: 86400,
    rateLimitMax: 5,
  }),
] as const;
