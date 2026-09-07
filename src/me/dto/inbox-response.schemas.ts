import { z } from "zod";
import {
  notificationListResponseSchema,
  notificationCountResponseSchema,
} from "../../modules/notifications/dto/notification-response-schema";

export { notificationListResponseSchema as inboxListResponseSchema };
export { notificationCountResponseSchema as inboxCountResponseSchema };

const inboxActorSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

const inboxItemBaseFields = {
  sourceModule: z.string(),
  actor: inboxActorSchema.nullable(),
  subject: z.string(),
  timestamp: z.string(),
  isRead: z.boolean(),
  deepLink: z.string().nullable(),
  dedupKey: z.string(),
};

const notificationInboxItemSchema = z.object({
  kind: z.literal("notification"),
  id: z.number().int(),
  notifType: z.string(),
  priority: z.string(),
  category: z.string(),
  eventKey: z.string().nullable(),
  body: z.string(),
  pinned: z.boolean(),
  ...inboxItemBaseFields,
});

const broadcastInboxItemSchema = z.object({
  kind: z.literal("broadcast"),
  id: z.number().int(),
  notifType: z.string(),
  priority: z.string(),
  category: z.string(),
  body: z.string(),
  ...inboxItemBaseFields,
});

const mailInboxItemSchema = z.object({
  kind: z.literal("mail"),
  id: z.string(),
  threadId: z.string().nullable(),
  accountId: z.number().int(),
  snippet: z.string(),
  hasAttachments: z.boolean(),
  ...inboxItemBaseFields,
});

const buildApprovalInboxItemSchema = z.object({
  kind: z.literal("build_approval"),
  id: z.number().int(),
  status: z.string(),
  projectId: z.number().int(),
  ticketId: z.number().int().nullable(),
  dueAt: z.string().nullable(),
  ...inboxItemBaseFields,
});

const sourceStatusSchema = z.object({
  kind: z.enum(["notification", "broadcast", "mail", "build_approval"]),
  included: z.boolean(),
  reason: z.string().nullable(),
});

export const unifiedInboxResponseSchema = z.object({
  items: z.array(
    z.discriminatedUnion("kind", [
      notificationInboxItemSchema,
      broadcastInboxItemSchema,
      mailInboxItemSchema,
      buildApprovalInboxItemSchema,
    ]),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  sources: z.array(sourceStatusSchema),
});

export const unifiedCountResponseSchema = z.object({
  notification: z.number().int(),
  mail: z.number().int(),
  approval: z.number().int(),
});
