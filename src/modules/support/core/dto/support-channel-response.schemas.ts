import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const supportChannelRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  type: z.enum(["email", "chat", "whatsapp", "sms"]),
  name: z.string(),
  config: z.record(z.string(), z.unknown()).nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const supportChannelWithSecretSchema = supportChannelRowSchema.and(
  z.object({ inboundSecret: z.string().nullable() }),
);

export const supportChannelListSchema = z.array(supportChannelRowSchema);

export const inboundIngestResultSchema = z.object({
  ticketId: z.number().int(),
  messageId: z.number().int().nullable(),
  deduped: z.boolean(),
});

export const startChatSessionResultSchema = z.object({
  ticketId: z.number().int(),
  sessionToken: z.string(),
});

export const chatSessionMessageSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ticketId: z.number().int(),
  authorId: z.string().nullable(),
  body: z.string(),
  isInternal: z.boolean(),
  sourceChannel: z.string(),
  sourceMessageId: z.string().nullable(),
  sourceContactEmail: z.string().nullable(),
  sourceContactName: z.string().nullable(),
  createdAt: wireDate(),
});

export const getChatSessionSchema = z.object({
  ticketId: z.number().int(),
  messages: z.array(chatSessionMessageSchema),
});

export const sendChatMessageResultSchema = z.object({
  ticketId: z.number().int(),
  messageId: z.number().int(),
});

export const ablyTokenRequestSchema = z.object({
  keyName: z.string(),
  ttl: z.number().int(),
  capability: z.string(),
  timestamp: z.number().int(),
  nonce: z.string(),
  mac: z.string(),
});

export { successSchema };
