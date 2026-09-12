import { Injectable } from "@nestjs/common";
import { CacheService } from "../../common/cache/cache.service";
import { ComposioToolError } from "../integrations/core/composio.gateway";
import { GmailMailProvider } from "./providers/gmail-mail.provider";
import { OutlookMailProvider } from "./providers/outlook-mail.provider";
import {
  decodeCursor,
  encodeCursor,
  mergeMessagesByDate,
  sortThreadChronologically,
  type AccountCursorValue,
  type NormalizerConnectionMeta,
  type OpaqueCursor,
} from "./providers/mail-normalizers";
import { decodeMetadataCursor } from "./providers/mail-metadata-cursor";
import { MailAccountsService } from "./mail-accounts.service";
import { MailMetadataService } from "./mail-metadata.service";
import { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";
import { listFromMetadata, pageFromMetadata } from "./mail-mirror-page";
import { advanceUnionCursor } from "./mail-union-cursor";
import { fetchMessagesForAccount, type MailFetchDeps } from "./mail-fetch-account";
import type {
  MailListResponse,
  MailMessageDetail,
} from "./dto/mail-response.schemas";
import type { MailFolder } from "./dto/mail-schemas";

@Injectable()
export class MailService {
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

    const fetchDeps: MailFetchDeps = {
      gmail: this.gmail,
      outlook: this.outlook,
      cache: this.cache,
      metadata: this.metadata,
      checkpoints: this.checkpoints,
    };

    const settled = await Promise.allSettled(
      targetAccounts.map((acc) =>
        fetchMessagesForAccount(
          fetchDeps,
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
}
