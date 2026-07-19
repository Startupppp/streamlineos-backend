import { z } from "zod";

export const inboxSummaryBodySchema = z.object({
  accountId: z.union([z.number().int().positive(), z.literal("all")]).optional(),
});
export type InboxSummaryInput = z.infer<typeof inboxSummaryBodySchema>;

export const threadSummaryBodySchema = z.object({
  accountId: z.number().int().positive(),
  threadId: z.string().min(1).max(500),
});
export type ThreadSummaryInput = z.infer<typeof threadSummaryBodySchema>;

export const draftBodySchema = z.object({
  mode: z.enum(["compose", "reply"]),
  instruction: z.string().min(1).max(2000),
  accountId: z.number().int().positive().optional(),
  threadId: z.string().min(1).max(500).optional(),
});
export type DraftInput = z.infer<typeof draftBodySchema>;

export const MailInboxSummaryOutputSchema = z.object({
  summary: z.string(),
  highlights: z.array(
    z.object({
      subject: z.string(),
      fromEmail: z.string(),
      reason: z.string(),
    }),
  ),
  actionItems: z.array(z.string()),
});
export type MailInboxSummaryOutput = z.infer<typeof MailInboxSummaryOutputSchema>;

export const MailThreadSummaryOutputSchema = z.object({
  summary: z.string(),
  actionItems: z.array(z.string()),
  suggestedReply: z.string(),
});
export type MailThreadSummaryOutput = z.infer<typeof MailThreadSummaryOutputSchema>;

export const MailDraftOutputSchema = z.object({
  subject: z.string(),
  bodyHtml: z.string(),
});
export type MailDraftOutput = z.infer<typeof MailDraftOutputSchema>;
