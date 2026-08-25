import { z } from "zod";
import type { FanoutInput } from "./message-fanout.interface";

export const CHAT_MESSAGE_FANOUT_EVENT = "chat.message.fanout";

export const chatMessageFanoutPayloadSchema = z.object({
  orgId: z.string().min(1),
  channelId: z.number().int().positive(),
  channelType: z.string().nullable(),
  message: z.object({
    id: z.number().int().positive(),
    channelId: z.number().int().positive(),
    senderId: z.string().min(1),
    content: z.string().nullable(),
    createdAt: z.coerce.date(),
    replyToId: z.number().int().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    messageType: z.enum(["text", "lead_submission", "system"]),
  }),
  content: z.string().nullable(),
  mentionedUserIds: z.array(z.string()).nullable(),
  attachments: z.array(z.record(z.string(), z.unknown())),
  strippedMetadata: z.record(z.string(), z.unknown()).nullable(),
  senderName: z.string().nullable(),
  senderImage: z.string().nullable(),
});

export type ChatMessageFanoutPayload = z.infer<typeof chatMessageFanoutPayloadSchema>;

export function fanoutInputFromPayload(payload: ChatMessageFanoutPayload): FanoutInput {
  return payload as FanoutInput;
}
