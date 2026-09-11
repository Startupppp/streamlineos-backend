import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const chatAttachmentSchema = z.object({
  id: z.number().int(),
  messageId: z.number().int(),
  fileName: z.string(),
  fileUrl: z.string(),
  fileKey: z.string(),
  fileSize: z.number().int(),
  mimeType: z.string(),
  createdAt: wireDate(),
});

const chatSenderSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

const chatMessageBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  channelId: z.number().int(),
  senderMembershipId: z.number().int().nullable(),
  content: z.string().nullable(),
  replyToId: z.number().int().nullable(),
  isEdited: z.boolean(),
  isDeleted: z.boolean(),
  messageType: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  actionStatus: z.string().nullable(),
  clientKey: z.string().nullable(),
  channelPosition: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  senderId: z.string().nullable(),
  sender: chatSenderSchema.nullable(),
  reactions: z.record(z.string(), z.array(z.string())),
  attachments: z.array(chatAttachmentSchema),
});

export const chatReplyPreviewSchema = z
  .object({
    id: z.number().int(),
    content: z.string().nullable(),
    senderId: z.string().nullable(),
    sender: chatSenderSchema,
  })
  .strict();

export const chatMessageSchema = chatMessageBaseSchema.extend({
  replyTo: chatReplyPreviewSchema.nullable().optional(),
});

export const chatMessagePageSchema = z.object({
  messages: z.array(chatMessageSchema),
  nextCursor: z.number().int().nullable(),
});

export const chatMessagePollPageSchema = z.object({
  messages: z.array(chatMessageSchema),
  nextCursor: z.number().int().nullable(),
  hasMore: z.boolean(),
});

export const chatThreadPageSchema = z.object({
  parentMessage: chatMessageSchema,
  replies: z.array(chatMessageSchema),
  nextCursor: z.number().int().nullable(),
});

export const chatRawMessageSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  channelId: z.number().int(),
  senderMembershipId: z.number().int().nullable(),
  content: z.string().nullable(),
  replyToId: z.number().int().nullable(),
  isEdited: z.boolean(),
  isDeleted: z.boolean(),
  messageType: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  actionStatus: z.string().nullable(),
  clientKey: z.string().nullable(),
  channelPosition: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const chatReactionsResponseSchema = z.object({
  reactions: z.record(z.string(), z.array(z.string())),
});

export const chatMessageOkSchema = z.object({ ok: z.literal(true) });
