import { z } from "zod";
import type { FanoutInput } from "./message-fanout.interface";
import type { ChatAttachmentPayload } from "./chat-message.types";

export const CHAT_MESSAGE_FANOUT_EVENT = "chat.message.fanout";

export const chatMessageFanoutPayloadSchema = z.object({
  orgId: z.string().min(1),
  channelId: z.number().int().positive(),
  channelType: z.string().nullable(),
  message: z.object({
    id: z.number().int().positive(),
    channelId: z.number().int().positive(),
    senderId: z.string().min(1).optional(),
    senderMembershipId: z.number().int().nullable().optional(),
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
  senderUserId: z.string().nullable().optional(),
});

export type ChatMessageFanoutPayload = z.infer<typeof chatMessageFanoutPayloadSchema>;

export function fanoutInputFromPayload(payload: ChatMessageFanoutPayload): FanoutInput {
  const senderUserId = payload.senderUserId ?? payload.message.senderId ?? null;
  return {
    orgId: payload.orgId,
    channelId: payload.channelId,
    channelType: payload.channelType,
    message: {
      id: payload.message.id,
      channelId: payload.message.channelId,
      senderMembershipId: payload.message.senderMembershipId ?? null,
      content: payload.message.content,
      createdAt: payload.message.createdAt,
      replyToId: payload.message.replyToId,
      metadata: payload.message.metadata,
      messageType: payload.message.messageType,
    },
    content: payload.content,
    mentionedUserIds: payload.mentionedUserIds ?? undefined,
    attachments: payload.attachments as ChatAttachmentPayload[],
    strippedMetadata: payload.strippedMetadata,
    senderName: payload.senderName,
    senderImage: payload.senderImage,
    senderUserId,
  };
}
