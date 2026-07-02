import { z } from "zod";

const channelBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  avatarUrl: z.string().optional(),
  memberIds: z.array(z.string()).min(1),
  entityType: z.enum(["project", "client", "task"]).optional(),
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
        .max(10),
    })
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
  limit: z.coerce.number().int().optional(),
});

export const pollQuerySchema = z.object({
  since: z.string().optional(),
});

export const searchQuerySchema = z.object({
  query: z.string().default(""),
  channelId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().optional(),
});

export const pinMessageSchema = z.object({
  messageId: z.number().int().positive(),
});

export const addMemberSchema = z.object({ userId: z.string().min(1) });
export const removeMemberSchema = z.object({ userId: z.string().min(1) });

export const muteChannelSchema = z.object({
  duration: z.enum(["15m", "1h", "8h", "24h", "forever"]),
});

export type MuteChannelInput = z.infer<typeof muteChannelSchema>;
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
export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;

export const ticketStatusActionSchema = z.object({
  channelId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  ticketId: z.number().int().positive(),
  nextStatus: z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]),
});
export type TicketStatusActionInput = z.infer<typeof ticketStatusActionSchema>;
