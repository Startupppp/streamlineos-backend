import { z } from "zod";

export const visitSchema = z.object({
  sessionToken: z.string().min(1).max(64),
  path: z.string().min(1).max(500),
  referrer: z.string().max(500).nullish(),
});

export type VisitInput = z.infer<typeof visitSchema>;

export const messageStatusSchema = z.enum(["NEW", "READ", "REPLIED", "ARCHIVED"]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const markStatusBodySchema = z.object({
  status: messageStatusSchema,
});

export const markRepliedBodySchema = z.object({
  replyBody: z.string().min(1).max(10_000),
  repliedById: z.string().min(1),
});

export const listMessagesQuerySchema = z.object({
  status: z.enum(["NEW", "READ", "REPLIED", "ARCHIVED", "ALL"]).optional(),
  topic: z.string().optional(),
  search: z.string().optional(),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;