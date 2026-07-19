import { Injectable } from "@nestjs/common";
import { ComposioGateway } from "../../integrations/composio.gateway";
import {
  normalizeOutlookMessage,
  unwrapComposioData,
  type NormalizerConnectionMeta,
} from "./mail-normalizers";
import type { MailFolder, MailMessageDetail, MailMessageSummary } from "../dto/mail-schemas";
import { z } from "zod";

const outlookListResponseSchema = z.object({
  value: z.array(z.unknown()).optional(),
});

const outlookAttachmentsResponseSchema = z.object({
  value: z.array(z.unknown()).optional(),
});

const outlookSearchResponseSchema = z.object({
  value: z.array(z.unknown()).optional(),
});

function folderToWellKnownName(folder: MailFolder): string {
  switch (folder) {
    case "inbox": return "Inbox";
    case "sent": return "SentItems";
    case "trash": return "DeletedItems";
    case "archive": return "Archive";
    case "starred": return "Inbox";
  }
}

const OUTLOOK_SELECT_FIELDS = [
  "id", "conversationId", "subject", "from", "toRecipients", "ccRecipients",
  "isRead", "flag", "receivedDateTime", "hasAttachments", "bodyPreview",
];

const OUTLOOK_DETAIL_FIELDS = [...OUTLOOK_SELECT_FIELDS, "body"];

@Injectable()
export class OutlookMailProvider {
  constructor(private readonly gateway: ComposioGateway) {}

  async listMessages(
    userId: string,
    conn: NormalizerConnectionMeta,
    folder: MailFolder,
    limit: number,
    skip: number,
    query?: string,
  ): Promise<{ messages: MailMessageSummary[]; nextSkip: number | null }> {
    let items: unknown[];

    if (query) {
      const raw = await this.gateway.executeTool(
        "OUTLOOK_OUTLOOK_SEARCH_MESSAGES",
        userId,
        { query, size: limit, from_index: skip },
        conn.id.toString(),
      );
      const data = unwrapComposioData(raw);
      const parsed = outlookSearchResponseSchema.safeParse(data);
      items = parsed.success ? (parsed.data.value ?? []) : [];
    } else {
      const isFlagFilter = folder === "starred";
      const args: Record<string, unknown> = {
        user_id: "me",
        folder: folderToWellKnownName(folder),
        top: limit,
        skip,
        select: OUTLOOK_SELECT_FIELDS,
        orderby: ["receivedDateTime desc"],
      };
      if (isFlagFilter) args.is_flagged = true;
      const raw = await this.gateway.executeTool(
        "OUTLOOK_OUTLOOK_LIST_MESSAGES",
        userId,
        args,
        conn.id.toString(),
      );
      const data = unwrapComposioData(raw);
      const parsed = outlookListResponseSchema.safeParse(data);
      items = parsed.success ? (parsed.data.value ?? []) : [];
    }

    const messages = items.map((item) => {
      try {
        return normalizeOutlookMessage(item, conn, false);
      } catch {
        return null;
      }
    }).filter((m): m is MailMessageSummary => m !== null);

    const nextSkip = messages.length === limit ? skip + limit : null;
    return { messages, nextSkip };
  }

  async getMessage(
    userId: string,
    conn: NormalizerConnectionMeta,
    messageId: string,
  ): Promise<MailMessageDetail> {
    const [rawMsg, rawAtts] = await Promise.all([
      this.gateway.executeTool(
        "OUTLOOK_OUTLOOK_GET_MESSAGE",
        userId,
        { user_id: "me", message_id: messageId, select: OUTLOOK_DETAIL_FIELDS.join(",") },
        conn.id.toString(),
      ),
      this.gateway.executeTool(
        "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS",
        userId,
        { user_id: "me", message_id: messageId },
        conn.id.toString(),
      ),
    ]);

    const attsData = unwrapComposioData(rawAtts);
    const attsParsed = outlookAttachmentsResponseSchema.safeParse(attsData);
    const attachmentItems = attsParsed.success ? (attsParsed.data.value ?? []) : [];

    return normalizeOutlookMessage(unwrapComposioData(rawMsg), conn, true, attachmentItems);
  }

  async getThread(
    userId: string,
    conn: NormalizerConnectionMeta,
    conversationId: string,
  ): Promise<MailMessageDetail[]> {
    const raw = await this.gateway.executeTool(
      "OUTLOOK_OUTLOOK_LIST_MESSAGES",
      userId,
      {
        user_id: "me",
        conversationId,
        top: 50,
        skip: 0,
        select: OUTLOOK_DETAIL_FIELDS,
        orderby: ["receivedDateTime asc"],
      },
      conn.id.toString(),
    );
    const data = unwrapComposioData(raw);
    const parsed = outlookListResponseSchema.safeParse(data);
    const items = parsed.success ? (parsed.data.value ?? []) : [];
    return items.map((item) => {
      try {
        return normalizeOutlookMessage(item, conn, true);
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
    const toRecipients = to.map((email) => ({ emailAddress: { address: email } }));
    const ccRecipients = (cc ?? []).map((email) => ({ emailAddress: { address: email } }));
    const bccRecipients = (bcc ?? []).map((email) => ({ emailAddress: { address: email } }));
    const payload = {
      message: {
        subject,
        body: { contentType: "HTML", content: bodyHtml },
        toRecipients,
        ccRecipients,
        bccRecipients,
      },
      saveToSentItems: true,
    };
    await this.gateway.executeProxy(conn.id.toString(), "POST", "/me/sendMail", payload);
  }

  async replyToMessage(
    userId: string,
    conn: NormalizerConnectionMeta,
    messageId: string,
    bodyHtml: string,
    cc?: string[],
  ): Promise<void> {
    const ccRecipients = (cc ?? []).map((email) => ({ emailAddress: { address: email } }));
    const payload = {
      message: { ccRecipients },
      comment: bodyHtml,
    };
    await this.gateway.executeProxy(conn.id.toString(), "POST", `/me/messages/${messageId}/reply`, payload);
  }

  async markRead(conn: NormalizerConnectionMeta, messageId: string, isRead: boolean): Promise<void> {
    await this.gateway.executeProxy(conn.id.toString(), "PATCH", `/me/messages/${messageId}`, { isRead });
  }

  async setFlag(conn: NormalizerConnectionMeta, messageId: string, flagStatus: "flagged" | "notFlagged"): Promise<void> {
    await this.gateway.executeProxy(conn.id.toString(), "PATCH", `/me/messages/${messageId}`, { flag: { flagStatus } });
  }

  async moveMessage(
    userId: string,
    conn: NormalizerConnectionMeta,
    messageId: string,
    destinationId: string,
  ): Promise<void> {
    await this.gateway.executeTool(
      "OUTLOOK_OUTLOOK_MOVE_MESSAGE",
      userId,
      { user_id: "me", message_id: messageId, destination_id: destinationId },
      conn.id.toString(),
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
      "OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT",
      userId,
      { user_id: "me", message_id: messageId, attachment_id: attachmentId, file_name: fileName },
      conn.id.toString(),
    );
    const data = unwrapComposioData(raw) as Record<string, unknown> | null;
    const downloadUrl = typeof data?.url === "string" ? data.url : (typeof data?.downloadUrl === "string" ? data.downloadUrl : "");
    return { downloadUrl, fileName };
  }
}
