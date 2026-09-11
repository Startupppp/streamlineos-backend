import { z } from "zod";
import type {
  MailAddress,
  MailAttachment,
  MailMessageDetail,
  MailMessageSummary,
  MailProvider,
} from "../dto/mail-schemas";
import {
  extractGmailAttachments,
  extractGmailBody,
  getGmailHeader,
  gmailHeaderSchema,
  gmailMessageSchema,
  gmailPartSchema,
  parseGmailAddress,
  parseGmailAddresses,
  parseGmailAttachmentList,
  resolveGmailDate,
} from "./lib/gmail-payload";

/**
 * Paging cursors are re-exported so every existing importer of this file is
 * unchanged; the rules that make one trustworthy live in `lib/mail-cursor.ts`.
 */
export {
  decodeCursor,
  encodeCursor,
  isPartialGmailCursor,
} from "./lib/mail-cursor";
export type {
  AccountCursorValue,
  OpaqueCursor,
  PartialGmailCursor,
} from "./lib/mail-cursor";


const SNIPPET_MAX = 160;

function clampSnippet(text: string): string {
  const stripped = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > SNIPPET_MAX ? stripped.slice(0, SNIPPET_MAX) : stripped;
}

function parseAddress(raw: unknown): MailAddress {
  if (raw === null || typeof raw !== "object") return { name: null, email: "" };
  const r = raw as Record<string, unknown>;
  const emailAddress = r.emailAddress;
  if (emailAddress !== null && typeof emailAddress === "object") {
    const ea = emailAddress as Record<string, unknown>;
    return { name: typeof ea.name === "string" ? ea.name : null, email: typeof ea.address === "string" ? ea.address : "" };
  }
  return { name: typeof r.name === "string" ? r.name : null, email: typeof r.email === "string" ? r.email : "" };
}

function parseAddresses(raw: unknown): MailAddress[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => parseAddress(item));
}

const outlookMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  subject: z.string().nullable().optional(),
  snippet: z.string().optional(),
  bodyPreview: z.string().optional(),
  from: z.unknown().optional(),
  toRecipients: z.array(z.unknown()).optional(),
  ccRecipients: z.array(z.unknown()).optional(),
  isRead: z.boolean().optional(),
  isFlagged: z.boolean().optional(),
  flag: z.object({ flagStatus: z.string().optional() }).optional(),
  receivedDateTime: z.string().optional(),
  sentDateTime: z.string().optional(),
  hasAttachments: z.boolean().optional(),
  body: z.object({
    contentType: z.string().optional(),
    content: z.string().optional(),
  }).optional(),
});

const outlookAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  contentType: z.string().optional(),
  size: z.number().optional(),
});

export function unwrapComposioData(data: unknown): unknown {
  if (data !== null && typeof data === "object" && "response_data" in data) {
    return (data as Record<string, unknown>).response_data;
  }
  return data;
}

export interface NormalizerConnectionMeta {
  id: number;
  composioAccountId: string;
  provider: MailProvider;
  accountEmail: string | null;
}

export function normalizeGmailMessage(
  raw: unknown,
  conn: NormalizerConnectionMeta,
  detailMode: false,
): MailMessageSummary;
export function normalizeGmailMessage(
  raw: unknown,
  conn: NormalizerConnectionMeta,
  detailMode: true,
): MailMessageDetail;
export function normalizeGmailMessage(
  raw: unknown,
  conn: NormalizerConnectionMeta,
  detailMode: boolean,
): MailMessageSummary | MailMessageDetail {
  const parsed = gmailMessageSchema.parse(raw);
  const id = parsed.messageId ?? parsed.id;
  if (!id) throw new Error("Gmail message is missing an id");
  const headers = gmailHeaderSchema.parse(parsed.payload?.headers ?? []);
  const from = parseGmailAddress(parsed.sender ?? getGmailHeader(headers, "from"));
  const toSource = typeof parsed.to === "string" && parsed.to ? parsed.to : getGmailHeader(headers, "to");
  const to = parseGmailAddresses(toSource);
  const cc = parseGmailAddresses(getGmailHeader(headers, "cc"));
  const subject = parsed.subject ?? getGmailHeader(headers, "subject") ?? "";
  const labels = parsed.labelIds ?? [];
  const isRead = !labels.includes("UNREAD");
  const isStarred = labels.includes("STARRED");
  const listAttachments = parseGmailAttachmentList(parsed.attachmentList);
  const hasAttachments =
    listAttachments.length > 0 ||
    (parsed.payload?.parts ?? []).some((p) => {
      const part = gmailPartSchema.safeParse(p);
      return part.success && Boolean(part.data.filename);
    });
  const date = resolveGmailDate(parsed.messageTimestamp, parsed.internalDate);
  const snippetSource =
    typeof parsed.preview === "string" && parsed.preview
      ? parsed.preview
      : (parsed.snippet ?? parsed.messageText ?? "");
  const snippet = clampSnippet(snippetSource);

  const summary: MailMessageSummary = {
    id,
    threadId: parsed.threadId ?? null,
    accountId: conn.id,
    provider: "gmail",
    from,
    to,
    subject: subject || "(no subject)",
    snippet,
    date,
    isRead,
    isStarred,
    hasAttachments,
  };

  if (!detailMode) return summary;

  const { html, text } = extractGmailBody(parsed.payload);
  const bodyAttachments = extractGmailAttachments(parsed.payload);
  const attachments = bodyAttachments.length > 0 ? bodyAttachments : listAttachments;

  return { ...summary, cc, bodyHtml: html, bodyText: text ?? parsed.messageText ?? null, attachments };
}

export function normalizeOutlookMessage(
  raw: unknown,
  conn: NormalizerConnectionMeta,
  detailMode: false,
  outlookAttachments?: unknown[],
): MailMessageSummary;
export function normalizeOutlookMessage(
  raw: unknown,
  conn: NormalizerConnectionMeta,
  detailMode: true,
  outlookAttachments?: unknown[],
): MailMessageDetail;
export function normalizeOutlookMessage(
  raw: unknown,
  conn: NormalizerConnectionMeta,
  detailMode: boolean,
  outlookAttachments?: unknown[],
): MailMessageSummary | MailMessageDetail {
  const parsed = outlookMessageSchema.parse(raw);
  const from = parseAddress(parsed.from);
  const to = parseAddresses(parsed.toRecipients ?? []);
  const cc = parseAddresses(parsed.ccRecipients ?? []);
  const subject = parsed.subject ?? "(no subject)";
  const isRead = parsed.isRead ?? true;
  const flagStatus = parsed.flag?.flagStatus ?? (parsed.isFlagged ? "flagged" : "notFlagged");
  const isStarred = flagStatus === "flagged";
  const hasAttachments = parsed.hasAttachments ?? false;
  const date = parsed.receivedDateTime ?? parsed.sentDateTime ?? new Date().toISOString();
  const snippet = clampSnippet(parsed.bodyPreview ?? parsed.snippet ?? "");

  const summary: MailMessageSummary = {
    id: parsed.id,
    threadId: parsed.conversationId ?? null,
    accountId: conn.id,
    provider: "outlook",
    from,
    to,
    subject,
    snippet,
    date,
    isRead,
    isStarred,
    hasAttachments,
  };

  if (!detailMode) return summary;

  const body = parsed.body;
  const bodyHtml = body?.contentType?.toLowerCase() === "html" ? (body.content ?? null) : null;
  const bodyText = body?.contentType?.toLowerCase() === "text" ? (body.content ?? null) : null;

  const attachments: MailAttachment[] = (outlookAttachments ?? []).map((rawAtt) => {
    const att = outlookAttachmentSchema.safeParse(rawAtt);
    if (!att.success) return null;
    return {
      id: att.data.id,
      fileName: att.data.name,
      mimeType: att.data.contentType ?? "application/octet-stream",
      sizeBytes: att.data.size ?? null,
    };
  }).filter((a): a is MailAttachment => a !== null);

  return { ...summary, cc, bodyHtml, bodyText, attachments };
}

export function mergeMessagesByDate(messages: MailMessageSummary[]): MailMessageSummary[] {
  return [...messages].sort((a, b) => b.date.localeCompare(a.date));
}
