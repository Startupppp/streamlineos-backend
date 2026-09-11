import { z } from "zod";
import { mailProviderSchema } from "./mail-schemas";

const mailAddressSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
});

const mailAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nullable(),
});

export const mailAccountSchema = z.object({
  id: z.number().int(),
  provider: z.string(),
  accountEmail: z.string().nullable(),
  accountLabel: z.string().nullable(),
  status: z.enum(["active", "needs_reauth", "disabled"]),
  isPrimary: z.boolean(),
  composioConnectedAccountId: z.string(),
});

export const mailAccountListSchema = z.array(mailAccountSchema);

const mailMessageSummarySchema = z.object({
  id: z.string(),
  threadId: z.string().nullable(),
  accountId: z.number().int(),
  provider: mailProviderSchema,
  from: mailAddressSchema,
  to: z.array(mailAddressSchema),
  subject: z.string(),
  snippet: z.string(),
  date: z.string(),
  isRead: z.boolean(),
  isStarred: z.boolean(),
  hasAttachments: z.boolean(),
});

export const mailListResponseSchema = z.object({
  messages: z.array(mailMessageSummarySchema),
  nextCursor: z.string().nullable(),
  accountErrors: z.array(
    z.object({
      accountId: z.number().int(),
      accountEmail: z.string().nullable(),
      message: z.string(),
    }),
  ),
});

const mailMessageDetailSchema = mailMessageSummarySchema.extend({
  cc: z.array(mailAddressSchema),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  attachments: z.array(mailAttachmentSchema),
});

export const mailMessageSchema = mailMessageDetailSchema;

export const mailThreadSchema = z.array(mailMessageDetailSchema);

export const mailSentSchema = z.object({ sent: z.literal(true) });

export const mailDownloadSchema = z.object({
  downloadUrl: z.string(),
  fileName: z.string(),
});

export type MailAddress = z.infer<typeof mailAddressSchema>;
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;
export type MailMessageSummary = z.infer<typeof mailMessageSummarySchema>;
export type MailMessageDetail = z.infer<typeof mailMessageDetailSchema>;
export type MailListResponse = z.infer<typeof mailListResponseSchema>;
export type MailDownloadResponse = z.infer<typeof mailDownloadSchema>;

export const mailAiInboxSummarySchema = z.object({
  summary: z.string(),
  highlights: z.array(
    z.object({
      subject: z.string(),
      fromEmail: z.string(),
      reason: z.string(),
    }),
  ),
  actionItems: z.array(z.string()),
  aiUsage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }).optional(),
});

export const mailAiThreadSummarySchema = z.object({
  summary: z.string(),
  actionItems: z.array(z.string()),
  suggestedReply: z.string(),
  aiUsage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }).optional(),
});

export const mailAiDraftSchema = z.object({
  subject: z.string(),
  bodyHtml: z.string(),
  aiUsage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }).optional(),
});

export const mailOkSchema = z.object({ ok: z.literal(true) });
