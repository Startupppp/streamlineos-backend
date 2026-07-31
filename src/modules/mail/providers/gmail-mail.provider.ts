import { Injectable } from "@nestjs/common";
import { ComposioGateway } from "../../integrations/core/composio.gateway";
import {
  normalizeGmailMessage,
  unwrapComposioData,
  type NormalizerConnectionMeta,
} from "./mail-normalizers";
import type { MailFolder, MailMessageDetail, MailMessageSummary } from "../dto/mail-schemas";
import { z } from "zod";

const gmailListResponseSchema = z.object({
  messages: z.array(z.unknown()).optional(),
  nextPageToken: z.string().optional(),
});

const gmailThreadResponseSchema = z.object({
  messages: z.array(z.unknown()).optional(),
});

const gmailAttachmentResponseSchema = z.object({
  downloadUrl: z.string().optional(),
  data: z.string().optional(),
  size: z.number().optional(),
});

function folderToLabelIds(folder: MailFolder): string[] {
  switch (folder) {
    case "inbox": return ["INBOX"];
    case "sent": return ["SENT"];
    case "trash": return ["TRASH"];
    case "starred": return ["STARRED"];
    case "archive": return [];
  }
}

@Injectable()
export class GmailMailProvider {
  constructor(private readonly gateway: ComposioGateway) {}

  async listMessages(
    userId: string,
    conn: NormalizerConnectionMeta,
    folder: MailFolder,
    limit: number,
    pageToken?: string,
    query?: string,
  ): Promise<{ messages: MailMessageSummary[]; nextPageToken: string | null }> {
    const labelIds = folderToLabelIds(folder);
    const args: Record<string, unknown> = {
      user_id: "me",
      max_results: limit,
      verbose: false,
      include_payload: true,
      include_spam_trash: folder === "trash",
    };
    if (labelIds.length > 0) args.label_ids = labelIds;
    if (pageToken) args.page_token = pageToken;
    if (query) args.query = query;
    if (folder === "archive") args.query = [query, "-label:inbox"].filter(Boolean).join(" ");

    const raw = await this.gateway.executeTool("GMAIL_FETCH_EMAILS", userId, args, conn.composioAccountId);
    const data = unwrapComposioData(raw);
    const parsed = gmailListResponseSchema.safeParse(data);
    const items = parsed.success ? (parsed.data.messages ?? []) : [];
    const nextPageToken = parsed.success ? (parsed.data.nextPageToken ?? null) : null;

    const messages = items.map((item) => {
      try {
        return normalizeGmailMessage(item, conn, false);
      } catch {
        return null;
      }
    }).filter((m): m is MailMessageSummary => m !== null);

    return { messages, nextPageToken };
  }

  async getMessage(
    userId: string,
    conn: NormalizerConnectionMeta,
    messageId: string,
  ): Promise<MailMessageDetail> {
    const raw = await this.gateway.executeTool(
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      userId,
      { user_id: "me", message_id: messageId, format: "full" },
      conn.composioAccountId,
    );
    return normalizeGmailMessage(unwrapComposioData(raw), conn, true);
  }

  async getThread(
    userId: string,
    conn: NormalizerConnectionMeta,
    threadId: string,
  ): Promise<MailMessageDetail[]> {
    const raw = await this.gateway.executeTool(
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      userId,
      { user_id: "me", thread_id: threadId },
      conn.composioAccountId,
    );
    const data = unwrapComposioData(raw);
    const parsed = gmailThreadResponseSchema.safeParse(data);
    const items = parsed.success ? (parsed.data.messages ?? []) : [];
    return items.map((item) => {
      try {
        return normalizeGmailMessage(item, conn, true);
      } catch {
        return null;
      }
    }).filter((m): m is MailMessageDetail => m !== null);
  }

  async sendEmail(
    userId: string,
    conn: NormalizerConnectionMeta,
    to: string[],
    subject: string,
    bodyHtml: string,
    cc?: string[],
    bcc?: string[],
  ): Promise<void> {
    const [primaryTo, ...extra] = to;
    await this.gateway.executeTool(
      "GMAIL_SEND_EMAIL",
      userId,
      {
        user_id: "me",
        recipient_email: primaryTo,
        extra_recipients: extra,
        subject,
        body: bodyHtml,
        is_html: true,
        cc: cc ?? [],
        bcc: bcc ?? [],
      },
      conn.composioAccountId,
    );
  }

  async replyToThread(
    userId: string,
    conn: NormalizerConnectionMeta,
    threadId: string,
    recipientEmail: string,
    bodyHtml: string,
    cc?: string[],
  ): Promise<void> {
    await this.gateway.executeTool(
      "GMAIL_REPLY_TO_THREAD",
      userId,
      {
        user_id: "me",
        thread_id: threadId,
        recipient_email: recipientEmail,
        message_body: bodyHtml,
        is_html: true,
        cc: cc ?? [],
      },
      conn.composioAccountId,
    );
  }

  async modifyThreadLabels(
    userId: string,
    conn: NormalizerConnectionMeta,
    threadId: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    await this.gateway.executeTool(
      "GMAIL_MODIFY_THREAD_LABELS",
      userId,
      {
        user_id: "me",
        thread_id: threadId,
        add_label_ids: addLabelIds,
        remove_label_ids: removeLabelIds,
      },
      conn.composioAccountId,
    );
  }

  async moveToTrash(
    userId: string,
    conn: NormalizerConnectionMeta,
    messageId: string,
  ): Promise<void> {
    await this.gateway.executeTool(
      "GMAIL_MOVE_TO_TRASH",
      userId,
      { user_id: "me", message_id: messageId },
      conn.composioAccountId,
    );
  }

  async getAttachment(
    userId: string,
    conn: NormalizerConnectionMeta,
    messageId: string,
    attachmentId: string,
    fileName: string,
  ): Promise<{ downloadUrl: string; fileName: string }> {
    const raw = await this.gateway.executeTool(
      "GMAIL_GET_ATTACHMENT",
      userId,
      { user_id: "me", message_id: messageId, attachment_id: attachmentId, file_name: fileName },
      conn.composioAccountId,
    );
    const data = unwrapComposioData(raw);
    const parsed = gmailAttachmentResponseSchema.safeParse(data);
    const downloadUrl = parsed.success ? (parsed.data.downloadUrl ?? "") : "";
    return { downloadUrl, fileName };
  }
}
