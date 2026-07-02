import { z } from "zod";

export const pushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string().optional(),
});

export type PushPayload = z.infer<typeof pushPayloadSchema>;

export const chatMessagePayloadSchema = z.object({
  id: z.number(),
  channelId: z.number(),
  senderId: z.string(),
  senderName: z.string().nullable(),
  content: z.string().nullable(),
  createdAt: z.date(),
  replyToId: z.number().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type ChatMessagePayload = z.infer<typeof chatMessagePayloadSchema>;
