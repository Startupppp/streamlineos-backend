import { BadRequestException, Injectable } from "@nestjs/common";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { ComposioToolError } from "../integrations/composio.gateway";
import { GmailMailProvider } from "./providers/gmail-mail.provider";
import { OutlookMailProvider } from "./providers/outlook-mail.provider";
import {
  decodeCursor,
  encodeCursor,
  mergeMessagesByDate,
  type NormalizerConnectionMeta,
} from "./providers/mail-normalizers";
import { MailAccountsService, type MailAccount } from "./mail-accounts.service";
import type {
  MailDownloadResponse,
  MailFolder,
  MailListResponse,
  MailMessageDetail,
} from "./dto/mail-schemas";

const CACHE_TTL_SECONDS = 45;

@Injectable()
export class MailService {
  constructor(
    private readonly accounts: MailAccountsService,
    private readonly gmail: GmailMailProvider,
    private readonly outlook: OutlookMailProvider,
    private readonly cache: CacheService,
  ) {}

  async listAccounts(orgId: string, userId: string) {
    return this.accounts.listAccounts(orgId, userId);
  }

  async listMessages(
    orgId: string,
    userId: string,
    folder: MailFolder,
    accountIdParam: string,
    limit: number,
    cursor?: string,
    query?: string,
  ): Promise<MailListResponse> {
    const allAccounts = await this.accounts.listAccounts(orgId, userId);
    const targetAccounts = accountIdParam === "all"
      ? allAccounts
      : allAccounts.filter((a) => a.id === Number(accountIdParam));

    if (targetAccounts.length === 0) {
      return { messages: [], nextCursor: null, accountErrors: [] };
    }

    const parsedCursor = cursor ? decodeCursor(cursor) : {};
    const skipCache = Boolean(query);

    const settled = await Promise.allSettled(
      targetAccounts.map((acc) => this.fetchMessagesForAccount(userId, acc, folder, limit, parsedCursor, query, skipCache)),
    );

    const allMessages: ReturnType<typeof mergeMessagesByDate> = [];
    const accountErrors: MailListResponse["accountErrors"] = [];
    const nextCursorMap: Record<number, string | number | undefined> = {};

    settled.forEach((outcome, i) => {
      const acc = targetAccounts[i];
      if (!acc) return;
      if (outcome.status === "fulfilled") {
        allMessages.push(...outcome.value.messages);
        nextCursorMap[acc.id] = outcome.value.nextProviderCursor;
      } else {
        const err = outcome.reason;
        const message = err instanceof Error ? err.message : "Failed to load messages";
        accountErrors.push({ accountId: acc.id, accountEmail: acc.accountEmail, message });
        if (err instanceof ComposioToolError && err.isAuthError) {
          void this.accounts.markNeedsReauth(acc.id);
        }
      }
    });

    const merged = mergeMessagesByDate(allMessages).slice(0, limit);
    const hasMore = Object.values(nextCursorMap).some((v) => v !== undefined && v !== null);
    const nextCursor = hasMore ? encodeCursor(nextCursorMap) : null;

    return { messages: merged, nextCursor, accountErrors };
  }

  private async fetchMessagesForAccount(
    userId: string,
    acc: MailAccount,
    folder: MailFolder,
    limit: number,
    parsedCursor: Record<number, string | number | undefined>,
    query: string | undefined,
    skipCache: boolean,
  ): Promise<{ messages: ReturnType<typeof mergeMessagesByDate>; nextProviderCursor: string | number | undefined }> {
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    const cursorValue = parsedCursor[acc.id];
    const cacheKey = CACHE_KEYS.mailMessages(acc.id, folder, String(cursorValue ?? ""), query ?? "");

    const fetcher = async () => {
      if (acc.provider === "gmail") {
        const pageToken = typeof cursorValue === "string" ? cursorValue : undefined;
        const result = await this.gmail.listMessages(userId, conn, folder, limit, pageToken, query);
        return { messages: result.messages, nextProviderCursor: result.nextPageToken ?? undefined };
      }
      const skip = typeof cursorValue === "number" ? cursorValue : 0;
      const result = await this.outlook.listMessages(userId, conn, folder, limit, skip, query);
      return { messages: result.messages, nextProviderCursor: result.nextSkip ?? undefined };
    };

    if (skipCache) return fetcher();
    return this.cache.cached(cacheKey, fetcher, CACHE_TTL_SECONDS);
  }

  async getMessage(
    orgId: string,
    userId: string,
    messageId: string,
    accountId: number,
  ): Promise<MailMessageDetail> {
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    try {
      if (acc.provider === "gmail") return await this.gmail.getMessage(userId, conn, messageId);
      return await this.outlook.getMessage(userId, conn, messageId);
    } catch (err) {
      if (err instanceof ComposioToolError && err.isAuthError) void this.accounts.markNeedsReauth(acc.id);
      throw err;
    }
  }

  async getThread(
    orgId: string,
    userId: string,
    threadId: string,
    accountId: number,
  ): Promise<MailMessageDetail[]> {
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    try {
      if (acc.provider === "gmail") return await this.gmail.getThread(userId, conn, threadId);
      return await this.outlook.getThread(userId, conn, threadId);
    } catch (err) {
      if (err instanceof ComposioToolError && err.isAuthError) void this.accounts.markNeedsReauth(acc.id);
      throw err;
    }
  }

  async sendMail(
    orgId: string,
    userId: string,
    accountId: number,
    to: string[],
    subject: string,
    bodyHtml: string,
    cc?: string[],
    bcc?: string[],
  ): Promise<void> {
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    if (acc.provider === "gmail") {
      await this.gmail.sendEmail(userId, conn, to, subject, bodyHtml, cc, bcc);
    } else {
      await this.outlook.sendEmail(userId, conn, to, subject, bodyHtml, cc, bcc);
    }
  }

  async replyMail(
    orgId: string,
    userId: string,
    accountId: number,
    messageId: string,
    threadId: string | undefined,
    bodyHtml: string,
    cc?: string[],
  ): Promise<void> {
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    if (acc.provider === "gmail") {
      if (!threadId) throw new BadRequestException("threadId is required for Gmail replies");
      await this.gmail.replyToThread(userId, conn, threadId, messageId, bodyHtml, cc);
    } else {
      await this.outlook.replyToMessage(userId, conn, messageId, bodyHtml, cc);
    }
  }

  async performAction(
    orgId: string,
    userId: string,
    messageId: string,
    accountId: number,
    action: "markRead" | "markUnread" | "star" | "unstar" | "archive" | "trash",
    threadId?: string,
  ): Promise<void> {
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };

    if (acc.provider === "gmail") {
      if (action === "trash") {
        await this.gmail.moveToTrash(userId, conn, messageId);
      } else {
        if (!threadId) {
          throw new BadRequestException("threadId is required for Gmail label operations");
        }
        switch (action) {
          case "markRead":
            await this.gmail.modifyThreadLabels(userId, conn, threadId, [], ["UNREAD"]);
            break;
          case "markUnread":
            await this.gmail.modifyThreadLabels(userId, conn, threadId, ["UNREAD"], []);
            break;
          case "star":
            await this.gmail.modifyThreadLabels(userId, conn, threadId, ["STARRED"], []);
            break;
          case "unstar":
            await this.gmail.modifyThreadLabels(userId, conn, threadId, [], ["STARRED"]);
            break;
          case "archive":
            await this.gmail.modifyThreadLabels(userId, conn, threadId, [], ["INBOX"]);
            break;
        }
      }
    } else {
      switch (action) {
        case "markRead":
          await this.outlook.markRead(conn, messageId, true);
          break;
        case "markUnread":
          await this.outlook.markRead(conn, messageId, false);
          break;
        case "star":
          await this.outlook.setFlag(conn, messageId, "flagged");
          break;
        case "unstar":
          await this.outlook.setFlag(conn, messageId, "notFlagged");
          break;
        case "archive":
          await this.outlook.moveMessage(userId, conn, messageId, "archive");
          break;
        case "trash":
          await this.outlook.moveMessage(userId, conn, messageId, "deleteditems");
          break;
      }
    }

    await this.cache.invalidatePattern(CACHE_KEYS.mailMessagesPattern(acc.id));
  }

  async getAttachment(
    orgId: string,
    userId: string,
    messageId: string,
    attachmentId: string,
    accountId: number,
    fileName: string,
  ): Promise<MailDownloadResponse> {
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    if (acc.provider === "gmail") {
      return this.gmail.getAttachment(userId, conn, messageId, attachmentId, fileName);
    }
    return this.outlook.getAttachment(userId, conn, messageId, attachmentId, fileName);
  }
}
