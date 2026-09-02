import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { signCursor } from "./mail-cursor-signing";
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

const gmailPartSchema = z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  body: z
    .object({
      data: z.string().optional(),
      size: z.number().optional(),
      attachmentId: z.string().optional(),
    })
    .optional(),
});

const gmailPayloadSchema = z.object({
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  mimeType: z.string().optional(),
  body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
  parts: z.array(z.unknown()).optional(),
});

const gmailMessageSchema = z.object({
  messageId: z.string().optional(),
  id: z.string().optional(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  preview: z.unknown().optional(),
  snippet: z.string().optional(),
  sender: z.string().optional(),
  to: z.unknown().optional(),
  subject: z.string().nullable().optional(),
  messageTimestamp: z.string().optional(),
  internalDate: z.string().optional(),
  messageText: z.string().optional(),
  attachmentList: z.array(z.unknown()).optional(),
  payload: gmailPayloadSchema.optional(),
});

const gmailAttachmentListItemSchema = z.object({
  attachmentId: z.string(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
});

function parseGmailAttachmentList(items: unknown[] | undefined): MailAttachment[] {
  if (!items) return [];
  const attachments: MailAttachment[] = [];
  for (const item of items) {
    const parsed = gmailAttachmentListItemSchema.safeParse(item);
    if (!parsed.success) continue;
    attachments.push({
      id: parsed.data.attachmentId,
      fileName: parsed.data.filename ?? "attachment",
      mimeType: parsed.data.mimeType ?? "application/octet-stream",
      sizeBytes: null,
    });
  }
  return attachments;
}

function resolveGmailDate(messageTimestamp?: string, internalDate?: string): string {
  if (messageTimestamp) {
    const d = new Date(messageTimestamp);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (internalDate) {
    const d = new Date(Number(internalDate));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
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

function extractGmailBody(payload: z.infer<typeof gmailPayloadSchema> | undefined): { html: string | null; text: string | null } {
  if (!payload) return { html: null, text: null };
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
  for (const rawPart of payload.parts ?? []) {
    const parsed = gmailPartSchema.safeParse(rawPart);
    if (!parsed.success) continue;
    const bodyData = parsed.data.body?.data;
    if (typeof bodyData !== "string") continue;
    if (parsed.data.mimeType === "text/html") {
      html = Buffer.from(bodyData, "base64url").toString("utf-8");
    } else if (parsed.data.mimeType === "text/plain" && !text) {
      text = Buffer.from(bodyData, "base64url").toString("utf-8");
    }
  }
  return { html, text };
}

function extractGmailAttachments(payload: z.infer<typeof gmailPayloadSchema> | undefined): MailAttachment[] {
  if (!payload?.parts) return [];
  const attachments: MailAttachment[] = [];
  for (const rawPart of payload.parts) {
    const parsed = gmailPartSchema.safeParse(rawPart);
    if (!parsed.success) continue;
    const { filename, body, mimeType } = parsed.data;
    if (!filename || !body?.attachmentId) continue;
    attachments.push({
      id: body.attachmentId,
      fileName: filename,
      mimeType: mimeType ?? "application/octet-stream",
      sizeBytes: body.size ?? null,
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

export interface PartialGmailCursor {
  readonly token: string;
  readonly skip: number;
}

/**
 * `null` means this account is exhausted; `undefined` means it has no position
 * yet and should start from the beginning. Collapsing the two loses a whole
 * mailbox: `JSON.stringify` drops an `undefined` value, so an account marked
 * done came back from the wire as absent and the next page re-read it from row
 * zero, re-delivering every message it had already returned.
 */
export type AccountCursorValue = string | number | PartialGmailCursor | null | undefined;

export interface OpaqueCursor {
  [accountId: number]: AccountCursorValue;
}

export function isPartialGmailCursor(v: unknown): v is PartialGmailCursor {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).token === "string" && typeof (v as Record<string, unknown>).skip === "number";
}

/**
 * The inbox cursor is a map of account id to that account's provider position,
 * and it goes to the client. Base64 alone made it editable: a caller could swap
 * one account's page token for another's, or carry a cursor minted for a
 * different user, and the value would reach a provider API unchecked.
 *
 * So it is signed, in the shape `unsubscribe-token.util.ts` already uses — HMAC
 * over the payload with a key namespaced off `ENCRYPTION_KEY`, so a mail cursor
 * signature can never be replayed against another feature derived from the same
 * secret. The reader's id is inside the signed body, which is what makes
 * substitution detectable rather than merely inconvenient.
 *
 * A cursor that is unreadable — wrong shape, bad signature, another reader's,
 * unparseable body — returns `{}`, the first page, which is the rule
 * `common/pagination/cursor.ts` states for every other cursor here. A missing
 * `ENCRYPTION_KEY` is deliberately *not* in that set: it is a server
 * misconfiguration, not a client problem, and degrading to page one would hide
 * it. `validateEnv()` requires the key at `main.ts:45`, so a booted server
 * cannot reach the throw; a test or script that calls these directly must set it.
 */
const CURSOR_VERSION = "m1";

interface SignedCursorBody {
  readonly u: string;
  readonly c: OpaqueCursor;
}

export function encodeCursor(cursor: OpaqueCursor, userId: string): string {
  const body: SignedCursorBody = { u: userId, c: cursor };
  const encoded = Buffer.from(JSON.stringify(body), "utf-8").toString("base64url");
  return `${CURSOR_VERSION}.${encoded}.${signCursor(encoded)}`;
}

export function decodeCursor(encoded: string, userId: string): OpaqueCursor {
  const parts = encoded.split(".");
  if (parts.length !== 3) return {};

  const [version, body, signature] = parts;
  if (version !== CURSOR_VERSION || !body || !signature) return {};

  const expected = Buffer.from(signCursor(body), "utf-8");
  const actual = Buffer.from(signature, "utf-8");
  if (expected.length !== actual.length) return {};
  if (!timingSafeEqual(expected, actual)) return {};

  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

    const { u, c } = parsed as Record<string, unknown>;
    if (typeof u !== "string" || u !== userId) return {};
    if (typeof c !== "object" || c === null || Array.isArray(c)) return {};

    return c as OpaqueCursor;
  } catch {
    return {};
  }
}

export function mergeMessagesByDate(messages: MailMessageSummary[]): MailMessageSummary[] {
  return [...messages].sort((a, b) => b.date.localeCompare(a.date));
}
