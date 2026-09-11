import { z } from "zod";
import type { MailAddress, MailAttachment } from "../../dto/mail-schemas";

/**
 * Gmail's wire dialect, decoded.
 *
 * Gmail and Outlook are not two variants of one payload. Graph hands back
 * structured JSON — addresses are objects, the body is a typed field — so its
 * normaliser is a field-for-field copy. Gmail hands back an RFC 5322 message:
 * headers as a name/value array, addresses as `Name <addr>` strings, the body
 * as base64url MIME parts that have to be walked, and the date in either of two
 * encodings. None of that is shared with Outlook and none of it is the
 * normaliser's output contract, which is why it sits here: every rule below can
 * be pinned from a raw payload fixture with no account and no provider meta.
 */

export const gmailHeaderSchema = z.array(z.object({ name: z.string(), value: z.string() }));

export const gmailPartSchema = z.object({
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

export const gmailPayloadSchema = z.object({
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  mimeType: z.string().optional(),
  body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
  parts: z.array(z.unknown()).optional(),
});

export const gmailMessageSchema = z.object({
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

export function parseGmailAttachmentList(items: unknown[] | undefined): MailAttachment[] {
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

export function resolveGmailDate(messageTimestamp?: string, internalDate?: string): string {
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
export function getGmailHeader(headers: z.infer<typeof gmailHeaderSchema>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function parseGmailAddress(raw: string): MailAddress {
  const match = /^(.+?)\s*<([^>]+)>$/.exec(raw.trim());
  if (match) return { name: match[1]?.trim() ?? null, email: match[2]?.trim() ?? "" };
  return { name: null, email: raw.trim() };
}

export function parseGmailAddresses(raw: string): MailAddress[] {
  if (!raw) return [];
  return raw.split(",").map((s) => parseGmailAddress(s.trim())).filter((a) => a.email);
}

export function extractGmailBody(payload: z.infer<typeof gmailPayloadSchema> | undefined): { html: string | null; text: string | null } {
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

export function extractGmailAttachments(payload: z.infer<typeof gmailPayloadSchema> | undefined): MailAttachment[] {
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
