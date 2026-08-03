import { z } from "zod";

export const pushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string().optional(),
});

export type PushPayload = z.infer<typeof pushPayloadSchema>;

export const chatAttachmentPayloadSchema = z.object({
  id: z.number(),
  fileName: z.string(),
  fileUrl: z.string(),
  fileKey: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
});

export const chatMessagePayloadSchema = z.object({
  id: z.number(),
  channelId: z.number(),
  senderId: z.string(),
  senderName: z.string().nullable(),
  senderImage: z.string().nullable().optional(),
  content: z.string().nullable(),
  createdAt: z.date(),
  replyToId: z.number().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  messageType: z.string().optional(),
  attachments: z.array(chatAttachmentPayloadSchema).optional(),
});

export type ChatAttachmentPayload = z.infer<typeof chatAttachmentPayloadSchema>;
export type ChatMessagePayload = z.infer<typeof chatMessagePayloadSchema>;
