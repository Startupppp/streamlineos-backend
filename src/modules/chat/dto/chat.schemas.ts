import { z } from "zod";
import {
  PRESENCE_CLEAR_AFTER_OPTIONS,
  PRESENCE_STATUSES,
  PRESENCE_STATUS_MESSAGE_MAX_LENGTH,
} from "../chat-presence-status";

import { idCursorSchema } from "../../../common/pagination/cursor.schema";
import { pageSizeField } from "../../../common/pagination/list-query.schema";
import { isWellFormedStorageKey } from "../../storage/storage-key";

const channelBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  avatarUrl: z.string().optional(),
  memberIds: z.array(z.string()).min(1).max(200),
});

export const createChannelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("DIRECT"),
    targetUserId: z.string().min(1),
  }).strict(),
  channelBaseSchema.extend({ type: z.literal("GROUP") }).strict(),
  channelBaseSchema.extend({ type: z.literal("PUBLIC") }).strict(),
  channelBaseSchema.extend({ type: z.literal("PRIVATE") }).strict(),
]);

export const updateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  avatarUrl: z.string().optional(),
}).strict();

export const sendMessageSchema = z.object({
  content: z.string().optional(),
  replyToId: z.number().optional(),
  // Optional so existing callers are unaffected; when present, a retried send
  // returns the original message instead of creating a second one.
  clientKey: z.string().min(1).max(100).optional(),
  mentionedUserIds: z.array(z.string().min(1)).max(200).optional(),
  attachments: z
    .array(
      z.object({
        fileName: z.string(),
        fileUrl: z.string(),
        fileKey: z.string().min(1).max(1024).refine(isWellFormedStorageKey, "Invalid file key"),
        fileSize: z.number(),
        mimeType: z.string(),
      }),
    )
    .optional(),
  metadata: z
    .object({
      entities: z
        .array(
          z.discriminatedUnion("type", [
            z.object({
              type: z.literal("ticket"),
              id: z.string(),
              projectId: z.number().int().positive(),
              ticketNumber: z.number().int().optional(),
              projectKey: z.string().optional(),
              title: z.string().optional(),
              status: z.string().optional(),
              priority: z.string().optional(),
            }),
            z.object({
              type: z.literal("comment"),
              id: z.string(),
              ticketId: z.number().int().positive(),
              projectId: z.number().int().positive(),
            }),
          ]),
        )
        .max(10)
        .optional(),
      forwardCount: z.number().int().positive().optional(),
    })
    .passthrough()
    .optional(),
}).strict();

export const editMessageSchema = z.object({
  content: z.string().min(1),
}).strict();

export const reactionSchema = z.object({
  emoji: z.string().min(1).max(4),
}).strict();

export const statusSchema = z.object({
  status: z.enum(PRESENCE_STATUSES),
  statusMessage: z.string().trim().max(PRESENCE_STATUS_MESSAGE_MAX_LENGTH).optional(),
  clearAfter: z.enum(PRESENCE_CLEAR_AFTER_OPTIONS).optional(),
}).strict();

export const listMessagesQuerySchema = z.object({
  cursor: idCursorSchema,
  limit: pageSizeField(50),
}).strict();

export const channelListQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: pageSizeField(50),
  })
  .strict();

export type ChannelListQuery = z.infer<typeof channelListQuerySchema>;

export const pollQuerySchema = z.object({
  since: z.string().optional(),
});

export const searchQuerySchema = z.object({
  query: z.string().default(""),
  channelId: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(20),
}).strict();

export const pinMessageSchema = z.object({
  messageId: z.number().int().positive(),
}).strict();

export const addMemberSchema = z.object({ userId: z.string().min(1) }).strict();

export const muteChannelSchema = z.object({
  duration: z.enum(["15m", "1h", "8h", "24h", "forever"]),
}).strict();

export const notificationPreferenceSchema = z.object({
  preference: z.enum(["DEFAULT", "ALL", "MENTIONS", "NOTHING"]),
}).strict();

export const updateChatOrgSettingsSchema = z.object({
  defaultNotificationPreference: z.enum(["ALL", "MENTIONS", "NOTHING"]).optional(),
  maxAttachmentSizeMb: z.number().int().min(1).max(1000).optional(),
  maxHuddleParticipants: z.number().int().min(2).max(500).optional(),
}).strict();

export type MuteChannelInput = z.infer<typeof muteChannelSchema>;
export type NotificationPreferenceInput = z.infer<typeof notificationPreferenceSchema>;
export type UpdateChatOrgSettingsInput = z.infer<typeof updateChatOrgSettingsSchema>;
export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type ReactionInput = z.infer<typeof reactionSchema>;
export type StatusInput = z.infer<typeof statusSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
type PollQuery = z.infer<typeof pollQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type PinMessageInput = z.infer<typeof pinMessageSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const createTaskFromMessageSchema = z.object({
  channelId: z.number().int().positive(),
  messageId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  type: z.enum(["TASK", "BUG"]),
  title: z.string().min(1).max(255).optional(),
}).strict();
export type CreateTaskFromMessageInput = z.infer<typeof createTaskFromMessageSchema>;

export const entityReferenceSchema = z.object({
  type: z.string().trim().min(1).max(64),
  id: z.string().trim().min(1).max(128),
});

export const entityActionsAvailableSchema = z.object({
  channelId: z.number().int().positive(),
  references: z.array(entityReferenceSchema).min(1).max(50),
}).strict();

export const submitEntityActionSchema = z.object({
  channelId: z.number().int().positive(),
  reference: entityReferenceSchema,
  actionId: z.string().trim().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict();

export type EntityActionsAvailableInput = z.infer<typeof entityActionsAvailableSchema>;
export type SubmitEntityActionInput = z.infer<typeof submitEntityActionSchema>;

export const entityActionOptionsSchema = z.object({
  channelId: z.number().int().positive(),
  reference: entityReferenceSchema,
}).strict();

export type EntityActionOptionsInput = z.infer<typeof entityActionOptionsSchema>;

export const memberRoleSchema = z.object({ role: z.enum(["ADMIN", "MEMBER"]) }).strict();
export type MemberRoleInput = z.infer<typeof memberRoleSchema>;
