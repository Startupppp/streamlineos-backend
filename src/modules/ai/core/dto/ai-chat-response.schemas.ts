import { z } from "zod";

export const chatMessageSchema = z.object({
  id: z.number().int(),
  role: z.string(),
  content: z.string(),
  createdAt: z.string(),
});

export const chatHistoryResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
  nextCursor: z.number().int().nullable(),
});

export const chatClearHistoryResponseSchema = z.object({ success: z.literal(true) });

export const aiConversationSchema = z.object({
  id: z.number().int(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listConversationsResponseSchema = z.object({
  conversations: z.array(aiConversationSchema),
  nextCursor: z.number().int().nullable(),
});

export const deleteConversationResponseSchema = z.object({ success: z.literal(true) });

export const confirmActionResponseSchema = z.object({
  ok: z.literal(true),
  result: z.record(z.string(), z.unknown()),
  summary: z.string(),
});

export const declineActionResponseSchema = z.object({
  declined: z.literal(true),
});
