import { z } from "zod";

export const createChannelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("DIRECT"),
    targetUserId: z.string().min(1),
  }),
  z.object({
    type: z.literal("GROUP"),
    name: z.string().min(1),
    description: z.string().optional(),
    avatarUrl: z.string().optional(),
    memberIds: z.array(z.string()).min(1),
  }),
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
