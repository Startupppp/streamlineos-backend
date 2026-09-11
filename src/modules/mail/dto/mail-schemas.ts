import { z } from "zod";

import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const mailFolderSchema = z.enum(["inbox", "sent", "archive", "trash", "starred"]);
export type MailFolder = z.infer<typeof mailFolderSchema>;

export const mailProviderSchema = z.enum(["gmail", "outlook"]);
export type MailProvider = z.infer<typeof mailProviderSchema>;

const emailAddressSchema = z.string().email();

export const listMessagesQuerySchema = z.object({
  folder: mailFolderSchema.default("inbox"),
  accountId: z.string().default("all"),
  q: z.string().max(500).optional(),
  cursor: z.string().max(2000).optional(),
  limit: pageSizeField(25, 50),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const getMessageQuerySchema = z.object({
  accountId: z.coerce.number().int().positive(),
});
export type GetMessageQuery = z.infer<typeof getMessageQuerySchema>;

export const getThreadQuerySchema = z.object({
  accountId: z.coerce.number().int().positive(),
});
export type GetThreadQuery = z.infer<typeof getThreadQuerySchema>;

export const getAttachmentQuerySchema = z.object({
  accountId: z.coerce.number().int().positive(),
  fileName: z.string().min(1).max(500),
});
export type GetAttachmentQuery = z.infer<typeof getAttachmentQuerySchema>;

export const sendMailSchema = z.object({
  accountId: z.number().int().positive(),
  to: z.array(emailAddressSchema).min(1).max(25),
  cc: z.array(emailAddressSchema).max(25).optional(),
  bcc: z.array(emailAddressSchema).max(25).optional(),
  subject: z.string().min(1).max(500),
  bodyHtml: z.string().min(1).max(100_000),
});
export type SendMailInput = z.infer<typeof sendMailSchema>;

/**
 * `to` is the reply's recipient, chosen by the sender.
 *
 * It is optional and capped at one address. Optional because a client that does
 * not send it keeps the historical behaviour — the server derives the recipient
 * from the message being replied to. Capped at one because that is what both
 * providers' reply primitives accept (`GMAIL_REPLY_TO_THREAD.recipient_email` is
 * a single address); additional addressees go in `cc`, which is honoured
 * end-to-end. Accepting a wider array here would put the field back in the state
 * this schema exists to fix: collected from the user, validated, then dropped.
 */
export const replyMailSchema = z.object({
  accountId: z.number().int().positive(),
  messageId: z.string().min(1).max(500),
  threadId: z.string().min(1).max(500).optional(),
  bodyHtml: z.string().min(1).max(100_000),
  to: z.array(emailAddressSchema).min(1).max(1).optional(),
  cc: z.array(emailAddressSchema).max(25).optional(),
});
export type ReplyMailInput = z.infer<typeof replyMailSchema>;

export const mailActionSchema = z.object({
  accountId: z.number().int().positive(),
  action: z.enum(["markRead", "markUnread", "star", "unstar", "archive", "trash"]),
  threadId: z.string().min(1).max(500).optional(),
});
export type MailActionInput = z.infer<typeof mailActionSchema>;
