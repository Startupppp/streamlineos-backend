import { z } from "zod";

export const visitSchema = z.object({
  sessionToken: z.string().min(1).max(64),
  path: z.string().min(1).max(500),
  referrer: z.string().max(500).nullish(),
});

export type VisitInput = z.infer<typeof visitSchema>;

export const messageStatusSchema = z.enum(["NEW", "READ", "REPLIED", "ARCHIVED"]);

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

export const contactFormSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  company: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  message: z.string().min(1).max(5000),
  topic: z.enum(["sales", "support", "partnership", "press", "other"]).optional(),
});
export type ContactFormInput = z.infer<typeof contactFormSchema>;

export const replyMessageSchema = z.object({
  body: z.string().min(1).max(10_000),
  repliedById: z.string().min(1),
});
export type ReplyMessageInput = z.infer<typeof replyMessageSchema>;

export const grantPlatformAdminSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
});