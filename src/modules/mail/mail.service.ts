import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../../common/cache/cache.service";
import { ComposioToolError } from "../integrations/core/composio.gateway";
import { GmailMailProvider } from "./providers/gmail-mail.provider";
import { OutlookMailProvider } from "./providers/outlook-mail.provider";
import {
  decodeCursor,
  encodeCursor,
  isPartialGmailCursor,
  mergeMessagesByDate,
  sortThreadChronologically,
  type AccountCursorValue,
  type NormalizerConnectionMeta,
  type OpaqueCursor,
} from "./providers/mail-normalizers";
import { decodeMetadataCursor } from "./providers/mail-metadata-cursor";
import { MailAccountsService, type MailAccount } from "./mail-accounts.service";
import { MailMetadataService } from "./mail-metadata.service";
import { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";
import { listFromMetadata, pageFromMetadata } from "./mail-mirror-page";
import { advanceUnionCursor } from "./mail-union-cursor";
import type {
  MailDownloadResponse,
  MailListResponse,
  MailMessageDetail,
} from "./dto/mail-response.schemas";
import type { MailFolder } from "./dto/mail-schemas";

const CACHE_TTL_SECONDS = 45;

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly accounts: MailAccountsService,
    private readonly gmail: GmailMailProvider,
    private readonly outlook: OutlookMailProvider,
    private readonly cache: CacheService,
    private readonly metadata: MailMetadataService,
    private readonly checkpoints: MailSyncCheckpointService,
  ) {}

  async listAccounts(orgId: string, userId: string) {
    return this.accounts.listAccounts(orgId, userId);
  }
  async countUnread(
    orgId: string,
    userId: string,
    membershipId: number | null,
    folder: MailFolder,
    scanLimit: number,
  ): Promise<{ unread: number; exact: boolean }> {
    const accounts = await this.accounts.listAccounts(orgId, userId);
    if (accounts.length === 0) return { unread: 0, exact: true };

    if (membershipId !== null) {
      const accountIds = accounts.map((acc) => acc.id);
      const fresh = await this.metadata.freshAccountIds(
        orgId,
        accountIds,
        folder,
      );
      if (fresh.length === accountIds.length) {
        const unread = await this.metadata.countUnread(
          orgId,
          membershipId,
          folder,
          accountIds,
        );
        return { unread, exact: true };
      }
    }

    const result = await this.listMessages(
      orgId,
      userId,
      membershipId,
      folder,
      "all",
      scanLimit,
      undefined,
    );
    return {
      unread: result.messages.filter((m) => !m.isRead).length,
      exact: result.messages.length < scanLimit,
    };
  }

  async listMessages(
    orgId: string,
    userId: string,
    membershipId: number | null,
    folder: MailFolder,
    accountIdParam: string,
    limit: number,
    cursor?: string,
    query?: string,
  ): Promise<MailListResponse> {
    const allAccounts = await this.accounts.listAccounts(orgId, userId);
    const targetAccounts =
      accountIdParam === "all"
        ? allAccounts
        : allAccounts.filter((a) => a.id === Number(accountIdParam));

    if (targetAccounts.length === 0) {
      return { messages: [], nextCursor: null, accountErrors: [] };
    }

    const metadataCursor = cursor ? decodeMetadataCursor(cursor, userId) : null;
    if (membershipId !== null) {
      if (metadataCursor !== null) {
        return pageFromMetadata(
          this.metadata,
          orgId,
          userId,
          membershipId,
          targetAccounts,
          folder,
          limit,
          query,
          metadataCursor,
        );
      }
      if (!cursor) {
        const page = await listFromMetadata(
          this.metadata,
          orgId,
          userId,
          membershipId,
          targetAccounts,
          folder,
          limit,
          query,
        );
        if (page) return page;
      }
    }

    const parsedCursor = cursor ? decodeCursor(cursor, userId) : {};
    const skipCache = Boolean(query);

    const settled = await Promise.allSettled(
      targetAccounts.map((acc) =>
        this.fetchMessagesForAccount(
          orgId,
          userId,
          membershipId,
          acc,
          folder,
          limit,
          parsedCursor,
          query,
          skipCache,
        ),
      ),
    );

    const allMessages: ReturnType<typeof mergeMessagesByDate> = [];
    const accountErrors: MailListResponse["accountErrors"] = [];
    const reauthAccountIds: number[] = [];
    const accountFetches: Array<{
      accId: number;
      provider: string;
      messages: ReturnType<typeof mergeMessagesByDate>;
      nextPageToken: string | undefined;
      outlookHasMore: boolean;
      currentCursorValue: AccountCursorValue;
    }> = [];
    const carriedCursors: Array<{ accId: number; value: AccountCursorValue }> =
      [];

    settled.forEach((outcome, i) => {
      const acc = targetAccounts[i];
      if (!acc) return;
      if (outcome.status === "fulfilled") {
        allMessages.push(...outcome.value.messages);
        accountFetches.push({
          accId: acc.id,
          provider: acc.provider,
          messages: outcome.value.messages,
          nextPageToken: outcome.value.nextPageToken,
          outlookHasMore: outcome.value.outlookHasMore,
          currentCursorValue: parsedCursor[acc.id],
        });
      } else {
        const err = outcome.reason;
        const message =
          err instanceof Error ? err.message : "Failed to load messages";
        accountErrors.push({
          accountId: acc.id,
          accountEmail: acc.accountEmail,
          message,
        });
        if (err instanceof ComposioToolError && err.isAuthError)
          reauthAccountIds.push(acc.id);
        const carried = parsedCursor[acc.id];
        if (carried !== undefined)
          carriedCursors.push({ accId: acc.id, value: carried });
      }
    });

    if (reauthAccountIds.length > 0)
      await this.accounts.markNeedsReauthMany(reauthAccountIds, orgId);

    const merged = mergeMessagesByDate(allMessages).slice(0, limit);
    const mergedIds = new Set(merged.map((m) => `${m.accountId}:${m.id}`));

    const nextCursorMap = advanceUnionCursor(
      accountFetches,
      mergedIds,
      carriedCursors,
    );

    const hasMore = Object.values(nextCursorMap).some(
      (v) => v !== undefined && v !== null,
    );
    const nextCursor = hasMore ? encodeCursor(nextCursorMap, userId) : null;

    return { messages: merged, nextCursor, accountErrors };
  }

  private async fetchMessagesForAccount(
    orgId: string,
    userId: string,
    membershipId: number | null,
    acc: MailAccount,
    folder: MailFolder,
    limit: number,
    parsedCursor: OpaqueCursor,
    query: string | undefined,
    skipCache: boolean,
  ): Promise<{
    messages: ReturnType<typeof mergeMessagesByDate>;
    nextPageToken: string | undefined;
    outlookHasMore: boolean;
  }> {
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };
    const cursorValue = parsedCursor[acc.id];
    if (cursorValue === null)
      return { messages: [], nextPageToken: undefined, outlookHasMore: false };
    const cacheKey = `${folder}:${JSON.stringify(cursorValue ?? "")}:${query ?? ""}`;

    const fetcher = async () => {
      let result: {
        messages: ReturnType<typeof mergeMessagesByDate>;
        nextPageToken: string | undefined;
        outlookHasMore: boolean;
      };
      if (acc.provider === "gmail") {
        let pageToken: string | undefined;
        let withinPageSkip = 0;
        if (isPartialGmailCursor(cursorValue)) {
          pageToken = cursorValue.token || undefined;
          withinPageSkip = cursorValue.skip;
        } else if (typeof cursorValue === "string") {
          pageToken = cursorValue;
        }
        const raw = await this.gmail.listMessages(
          userId,
          conn,
          folder,
          limit + withinPageSkip,
          pageToken,
          query,
        );
        result = {
          messages: raw.messages.slice(withinPageSkip),
          nextPageToken: raw.nextPageToken ?? undefined,
          outlookHasMore: false,
        };
      } else {
        const skip = typeof cursorValue === "number" ? cursorValue : 0;
        const raw = await this.outlook.listMessages(
          userId,
          conn,
          folder,
          limit,
          skip,
          query,
        );
        result = {
          messages: raw.messages,
          nextPageToken: undefined,
          outlookHasMore: raw.nextSkip !== null && raw.nextSkip !== undefined,
        };
      }

      if (!query && result.messages.length > 0 && membershipId !== null) {
        this.metadata.deferUpsertBatch(
          acc.id,
          membershipId,
          orgId,
          folder,
          result.messages,
        );
        await this.checkpoints
          .savePosition(orgId, acc.id, folder, result.nextPageToken ?? null)
          .catch((err: unknown) => {
            this.logger.error(
              `checkpoint save failed orgId=${orgId} accountId=${acc.id} folder=${folder}`,
              err instanceof Error ? err.stack : String(err),
            );
          });
      }

      return result;
    };

    if (skipCache) return fetcher();
    return this.cache.cachedVersioned(
      `mail:messages:${acc.id}`,
      cacheKey,
      fetcher,
      CACHE_TTL_SECONDS,
    );
  }

  async getMessage(
    orgId: string,
    userId: string,
    messageId: string,
    accountId: number,
  ): Promise<MailMessageDetail> {
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };
    try {
      if (acc.provider === "gmail")
        return await this.gmail.getMessage(userId, conn, messageId);
      return await this.outlook.getMessage(userId, conn, messageId);
    } catch (err) {
      if (err instanceof ComposioToolError && err.isAuthError)
        await this.accounts.markNeedsReauth(acc.id, orgId);
      throw err;
    }
  }

  async getThread(
    orgId: string,
    userId: string,
    threadId: string,
    accountId: number,
  ): Promise<MailMessageDetail[]> {
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };
    try {
      const messages =
        acc.provider === "gmail"
          ? await this.gmail.getThread(userId, conn, threadId)
          : await this.outlook.getThread(userId, conn, threadId);
      return sortThreadChronologically(messages);
    } catch (err) {
      if (err instanceof ComposioToolError && err.isAuthError)
        await this.accounts.markNeedsReauth(acc.id, orgId);
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
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };
    if (acc.provider === "gmail") {
      await this.gmail.sendEmail(userId, conn, to, subject, bodyHtml, cc, bcc);
    } else {
      await this.outlook.sendEmail(
        userId,
        conn,
        to,
        subject,
        bodyHtml,
        cc,
        bcc,
      );
    }
  }

  /**
   * Send `bodyHtml` as a reply to `messageId`.
   *
   * `to` is the recipient the sender chose in the compose sheet. It used to have
   * nowhere to go: the reply form collected a required, validated To address and
   * the request body had no field for it, so a sender who changed the recipient
   * got a "Reply sent" toast for a message delivered to whoever the server
   * derived instead. Both providers can be told a recipient — Gmail through
   * `recipient_email`, Graph through the `message.toRecipients` of the reply
   * action it already uses for `ccRecipients` — so the address is carried
   * through rather than the field being removed.
   *
   * Absent `to`, the derivation stays exactly as it was: the original sender,
   * unless this account IS the original sender, in which case the message's
   * first To address (replying to something you sent goes to the person you sent
   * it to, not back to yourself).
   */
  async replyMail(
    orgId: string,
    userId: string,
    accountId: number,
    messageId: string,
    threadId: string | undefined,
    bodyHtml: string,
    cc?: string[],
    to?: string[],
  ): Promise<void> {
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };
    const requestedRecipient = to?.[0];
    if (acc.provider === "gmail") {
      if (!threadId)
        throw new BadRequestException("threadId is required for Gmail replies");
      let recipientEmail = requestedRecipient;
      if (!recipientEmail) {
        const original = await this.gmail.getMessage(userId, conn, messageId);
        recipientEmail =
          original.from.email !== acc.accountEmail
            ? original.from.email
            : original.to[0]?.email;
      }
      if (!recipientEmail)
        throw new BadRequestException(
          "Cannot determine reply recipient: original message has no resolvable address",
        );
      await this.gmail.replyToThread(userId, conn, {
        threadId,
        recipientEmail,
        bodyHtml,
        cc,
      });
    } else {
      await this.outlook.replyToMessage(
        userId,
        conn,
        messageId,
        bodyHtml,
        cc,
        requestedRecipient,
      );
    }
  }

  async performAction(
    orgId: string,
    userId: string,
    membershipId: number | null,
    messageId: string,
    accountId: number,
    action: "markRead" | "markUnread" | "star" | "unstar" | "archive" | "trash",
    threadId?: string,
  ): Promise<void> {
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };

    if (acc.provider === "gmail") {
      if (action === "trash") {
        await this.gmail.moveToTrash(userId, conn, messageId);
      } else {
        if (!threadId) {
          throw new BadRequestException(
            "threadId is required for Gmail label operations",
          );
        }
        switch (action) {
          case "markRead":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              [],
              ["UNREAD"],
            );
            break;
          case "markUnread":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              ["UNREAD"],
              [],
            );
            break;
          case "star":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              ["STARRED"],
              [],
            );
            break;
          case "unstar":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              [],
              ["STARRED"],
            );
            break;
          case "archive":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              [],
              ["INBOX"],
            );
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
          await this.outlook.moveMessage(
            userId,
            conn,
            messageId,
            "deleteditems",
          );
          break;
      }
    }

    await this.cache.invalidateNamespace(`mail:messages:${acc.id}`);

    const stateUpdate: {
      isRead?: boolean;
      isStarred?: boolean;
      folder?: string;
    } = {};
    if (action === "markRead") stateUpdate.isRead = true;
    else if (action === "markUnread") stateUpdate.isRead = false;
    else if (action === "star") stateUpdate.isStarred = true;
    else if (action === "unstar") stateUpdate.isStarred = false;
    else if (action === "archive") stateUpdate.folder = "archive";
    else if (action === "trash") stateUpdate.folder = "trash";

    if (Object.keys(stateUpdate).length > 0 && membershipId !== null) {
      this.metadata.deferUpdateState(
        acc.id,
        membershipId,
        orgId,
        messageId,
        stateUpdate,
      );
    }
  }

  async getAttachment(
    orgId: string,
    userId: string,
    messageId: string,
    attachmentId: string,
    accountId: number,
    fileName: string,
  ): Promise<MailDownloadResponse> {
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };
    if (acc.provider === "gmail") {
      return this.gmail.getAttachment(
        userId,
        conn,
        messageId,
        attachmentId,
        fileName,
      );
    }
    return this.outlook.getAttachment(
      userId,
      conn,
      messageId,
      attachmentId,
      fileName,
    );
  }
}
