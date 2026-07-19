import { z } from "zod";
import type {
  MailAddress,
  MailAttachment,
  MailMessageDetail,
  MailMessageSummary,
  MailProvider,
} from "../dto/mail-schemas";

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

const gmailHeaderSchema = z.array(z.object({ name: z.string(), value: z.string() }));

const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  payload: z.object({
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
    parts: z.array(z.unknown()).optional(),
  }).optional(),
  internalDate: z.string().optional(),
});

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

function getGmailHeader(headers: z.infer<typeof gmailHeaderSchema>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseGmailAddress(raw: string): MailAddress {
  const match = /^(.+?)\s*<([^>]+)>$/.exec(raw.trim());
  if (match) return { name: match[1]?.trim() ?? null, email: match[2]?.trim() ?? "" };
  return { name: null, email: raw.trim() };
}

function parseGmailAddresses(raw: string): MailAddress[] {
  if (!raw) return [];
  return raw.split(",").map((s) => parseGmailAddress(s.trim())).filter((a) => a.email);
}

function extractGmailBody(payload: z.infer<typeof gmailMessageSchema>["payload"]): { html: string | null; text: string | null } {
  if (!payload) return { html: null, text: null };
  const parts = payload.parts ?? [];
  if (payload.mimeType === "text/html") {
    const data = payload.body?.data;
    return { html: data ? Buffer.from(data, "base64url").toString("utf-8") : null, text: null };
  }
  if (payload.mimeType === "text/plain") {
    const data = payload.body?.data;
    return { html: null, text: data ? Buffer.from(data, "base64url").toString("utf-8") : null };
  }
  let html: string | null = null;
  let text: string | null = null;
  for (const rawPart of parts) {
    const part = rawPart as Record<string, unknown>;
    const mimeType = String(part.mimeType ?? "");
    const bodyData = (part.body as Record<string, unknown> | undefined)?.data;
    if (mimeType === "text/html" && typeof bodyData === "string") {
      html = Buffer.from(bodyData, "base64url").toString("utf-8");
    } else if (mimeType === "text/plain" && typeof bodyData === "string" && !text) {
      text = Buffer.from(bodyData, "base64url").toString("utf-8");
    }
  }
  return { html, text };
}

function extractGmailAttachments(payload: z.infer<typeof gmailMessageSchema>["payload"]): MailAttachment[] {
  if (!payload?.parts) return [];
  const attachments: MailAttachment[] = [];
  for (const rawPart of payload.parts) {
    const part = rawPart as Record<string, unknown>;
    const filename = part.filename;
    if (typeof filename !== "string" || !filename) continue;
    const body = part.body as Record<string, unknown> | undefined;
    const attachmentId = body?.attachmentId;
    if (typeof attachmentId !== "string") continue;
    attachments.push({
      id: attachmentId,
      fileName: filename,
      mimeType: typeof part.mimeType === "string" ? part.mimeType : "application/octet-stream",
      sizeBytes: typeof body?.size === "number" ? body.size : null,
    });
  }
  return attachments;
}

export function unwrapComposioData(data: unknown): unknown {
  if (data !== null && typeof data === "object" && "response_data" in data) {
    return (data as Record<string, unknown>).response_data;
  }
  return data;
}

export interface NormalizerConnectionMeta {
  id: number;
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
  const headers = gmailHeaderSchema.parse(parsed.payload?.headers ?? []);
  const from = parseGmailAddress(getGmailHeader(headers, "from"));
  const to = parseGmailAddresses(getGmailHeader(headers, "to"));
  const cc = parseGmailAddresses(getGmailHeader(headers, "cc"));
  const subject = getGmailHeader(headers, "subject") || "(no subject)";
  const labels = parsed.labelIds ?? [];
  const isRead = !labels.includes("UNREAD");
  const isStarred = labels.includes("STARRED");
  const hasAttachments = (parsed.payload?.parts ?? []).some((p) => {
    const part = p as Record<string, unknown>;
    return typeof part.filename === "string" && part.filename.length > 0;
  });
  const dateMs = parsed.internalDate ? Number(parsed.internalDate) : Date.now();
  const date = new Date(dateMs).toISOString();
  const snippet = clampSnippet(parsed.snippet ?? "");

  const summary: MailMessageSummary = {
    id: parsed.id,
    threadId: parsed.threadId ?? null,
    accountId: conn.id,
    provider: "gmail",
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

  const { html, text } = extractGmailBody(parsed.payload);
  const attachments = extractGmailAttachments(parsed.payload);

  return { ...summary, cc, bodyHtml: html, bodyText: text, attachments };
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

export interface OpaqueCursor {
  [accountId: number]: string | number | undefined;
}

export function encodeCursor(cursor: OpaqueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

export function decodeCursor(encoded: string): OpaqueCursor {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as OpaqueCursor;
    }
    return {};
  } catch {
    return {};
  }
}

export function mergeMessagesByDate(messages: MailMessageSummary[]): MailMessageSummary[] {
  return [...messages].sort((a, b) => b.date.localeCompare(a.date));
}
