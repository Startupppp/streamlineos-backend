import { z } from "zod";
import type { MailFolder, MailMessageSummary } from "../dto/mail-schemas";

export const outlookListResponseSchema = z.object({
  value: z.array(z.unknown()).optional(),
});

export const outlookAttachmentsResponseSchema = z.object({
  value: z.array(z.unknown()).optional(),
});

export const outlookAttachmentDownloadSchema = z.object({
  url: z.string().optional(),
  downloadUrl: z.string().optional(),
}).nullable();

export const outlookSearchResponseSchema = z.object({
  value: z.array(z.unknown()).optional(),
});

export function folderToWellKnownName(folder: MailFolder): string {
  switch (folder) {
    case "inbox": return "Inbox";
    case "sent": return "SentItems";
    case "trash": return "DeletedItems";
    case "archive": return "Archive";
    case "starred": return "Inbox";
  }
}

export const OUTLOOK_SELECT_FIELDS = [
  "id", "conversationId", "subject", "from", "toRecipients", "ccRecipients",
  "isRead", "flag", "receivedDateTime", "hasAttachments", "bodyPreview",
];

export const OUTLOOK_DETAIL_FIELDS = [...OUTLOOK_SELECT_FIELDS, "body"];

export interface OutlookMessageWithLabels extends MailMessageSummary {
  /**
   * The message's categories, or `null` when the response did not carry the
   * field at all.
   *
   * The distinction is the whole point: an empty array is "this person applied
   * none", `null` is "the provider did not say", and a caller deciding whether
   * a message is private has to treat the second as a refusal rather than as a
   * yes.
   */
  labels: string[] | null;
}

export function readCategories(item: unknown): string[] | null {
  if (item === null || typeof item !== "object") return null;
  if (!("categories" in item)) return null;
  const { categories } = item;
  if (!Array.isArray(categories)) return null;
  return categories.filter((category): category is string => typeof category === "string");
}
