import { z } from "zod";

const channelBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  avatarUrl: z.string().optional(),
  memberIds: z.array(z.string()).min(1),
  entityType: z.enum(["project", "client", "task", "sprint", "release", "incident"]).optional(),
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
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const pollQuerySchema = z.object({
  since: z.string().optional(),
});

export const searchQuerySchema = z.object({
  query: z.string().default(""),
  channelId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
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

export const ticketStatusActionSchema = z.object({
  channelId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  ticketId: z.number().int().positive(),
  nextStatus: z.string().min(1).max(100),
});
export type TicketStatusActionInput = z.infer<typeof ticketStatusActionSchema>;

export const createTaskFromMessageSchema = z.object({
  channelId: z.number().int().positive(),
  messageId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  type: z.enum(["TASK", "BUG"]),
  title: z.string().min(1).max(255).optional(),
});
export type CreateTaskFromMessageInput = z.infer<typeof createTaskFromMessageSchema>;

export const assignTicketFromChatSchema = z.object({
  channelId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  ticketId: z.number().int().positive(),
  assigneeId: z.string().min(1),
});
export type AssignTicketFromChatInput = z.infer<typeof assignTicketFromChatSchema>;

export const setDueDateFromChatSchema = z.object({
  channelId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  ticketId: z.number().int().positive(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
});
export type SetDueDateFromChatInput = z.infer<typeof setDueDateFromChatSchema>;
