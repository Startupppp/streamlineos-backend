import { z } from "zod";

import { idCursorSchema } from "../../../common/pagination/cursor.schema";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

const channelBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  avatarUrl: z.string().optional(),
  memberIds: z.array(z.string()).min(1).max(200),
  entityType: z
    .enum([
      "project",
      "client",
      "deal",
      "task",
      "ticket",
      "sprint",
      "release",
      "incident",
    ])
    .optional(),
  entityId: z.string().optional(),
});

export const createChannelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("DIRECT"),
    targetUserId: z.string().min(1),
  }),
  channelBaseSchema.extend({ type: z.literal("GROUP") }),
  channelBaseSchema.extend({ type: z.literal("PUBLIC") }),
  channelBaseSchema.extend({ type: z.literal("PRIVATE") }),
]);

export const updateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().optional(),
  replyToId: z.number().optional(),
  mentionedUserIds: z.array(z.string().min(1)).max(200).optional(),
  attachments: z
    .array(
      z.object({
        fileName: z.string(),
        fileUrl: z.string(),
        fileKey: z.string(),
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
});

export const editMessageSchema = z.object({
  content: z.string().min(1),
});

export const reactionSchema = z.object({
  emoji: z.string().min(1).max(4),
});

export const statusSchema = z.object({
  status: z.enum(["ONLINE", "AWAY", "OFFLINE"]),
});

export const listMessagesQuerySchema = z.object({
  cursor: idCursorSchema,
  limit: pageSizeField(50),
});

export const pollQuerySchema = z.object({
  since: z.string().optional(),
});

export const searchQuerySchema = z.object({
  query: z.string().default(""),
  channelId: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(20),
});

export const pinMessageSchema = z.object({
  messageId: z.number().int().positive(),
});

export const addMemberSchema = z.object({ userId: z.string().min(1) });

export const muteChannelSchema = z.object({
  duration: z.enum(["15m", "1h", "8h", "24h", "forever"]),
});

export const notificationPreferenceSchema = z.object({
  preference: z.enum(["DEFAULT", "ALL", "MENTIONS", "NOTHING"]),
});

export const updateChatOrgSettingsSchema = z.object({
  defaultNotificationPreference: z.enum(["ALL", "MENTIONS", "NOTHING"]).optional(),
  maxAttachmentSizeMb: z.number().int().min(1).max(1000).optional(),
  maxHuddleParticipants: z.number().int().min(2).max(500).optional(),
});

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
export type PollQuery = z.infer<typeof pollQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type PinMessageInput = z.infer<typeof pinMessageSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const createTaskFromMessageSchema = z.object({
  channelId: z.number().int().positive(),
  messageId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  type: z.enum(["TASK", "BUG"]),
  title: z.string().min(1).max(255).optional(),
});
export type CreateTaskFromMessageInput = z.infer<typeof createTaskFromMessageSchema>;

export const entityReferenceSchema = z.object({
  type: z.string().trim().min(1).max(64),
  id: z.string().trim().min(1).max(128),
});

export const entityActionsAvailableSchema = z.object({
  channelId: z.number().int().positive(),
  references: z.array(entityReferenceSchema).min(1).max(50),
});

export const submitEntityActionSchema = z.object({
  channelId: z.number().int().positive(),
  reference: entityReferenceSchema,
  actionId: z.string().trim().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
});

export type EntityActionsAvailableInput = z.infer<typeof entityActionsAvailableSchema>;
export type SubmitEntityActionInput = z.infer<typeof submitEntityActionSchema>;

export const entityActionOptionsSchema = z.object({
  channelId: z.number().int().positive(),
  reference: entityReferenceSchema,
});

export type EntityActionOptionsInput = z.infer<typeof entityActionOptionsSchema>;
