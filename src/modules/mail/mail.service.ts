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
import {
  decodeMetadataCursor,
  encodeMetadataCursor,
  type MailMetadataCursor,
} from "./providers/mail-metadata-cursor";
import { MailAccountsService, type MailAccount } from "./mail-accounts.service";
import { MailMetadataService, type CachedMailPage } from "./mail-metadata.service";
import { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";
import type {
  MailDownloadResponse,
  MailFolder,
  MailListResponse,
  MailMessageDetail,
  MailMessageSummary,
} from "./dto/mail-schemas";

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

  /**
   * How many messages in `folder` are unread, for the unread badge.
   *
   * The badge is rendered by every authenticated page, and it used to be derived
   * by listing `scanLimit` messages per connected mailbox out of Gmail/Graph and
   * counting `!isRead` in JavaScript — a provider fanout on every page load, and
   * an answer that was only ever `exact` when the mailbox happened to hold fewer
   * than `scanLimit` messages.
   *
   * `mail_message_metadata` already mirrors exactly the rows being counted: it is
   * upserted on every inbox load by `deferUpsertBatch`, whichever read path
   * served that load. So when every connected mailbox's copy of `folder` is
   * fresh, one indexed aggregate against the mirror answers it exactly.
   *
   * The provider fanout stays as the cold and stale path rather than being
   * deleted, because the mirror only holds what has already been listed — a
   * member who has never opened their inbox has no rows, and counting zero there
   * would be wrong rather than slow. That fanout also refreshes the mirror on its
   * way through, so the following call is served locally.
   *
   * All-fresh rather than per-account is deliberate: mixing a mirrored count for
   * some mailboxes with a scanned count for others would double-count nothing but
   * would report `exact` for a number that is partly a 100-message sample.
   */
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
      const fresh = await this.metadata.freshAccountIds(orgId, accountIds, folder);
      if (fresh.length === accountIds.length) {
        const unread = await this.metadata.countUnread(orgId, membershipId, folder, accountIds);
        return { unread, exact: true };
      }
    }

    const result = await this.listMessages(
      orgId, userId, membershipId, folder, "all", scanLimit, undefined,
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
    const targetAccounts = accountIdParam === "all"
      ? allAccounts
      : allAccounts.filter((a) => a.id === Number(accountIdParam));

    if (targetAccounts.length === 0) {
      return { messages: [], nextCursor: null, accountErrors: [] };
    }

    // The paging regime is chosen once, at page one, and then carried in the cursor:
    // a keyset against the local mirror and a provider page token resume differently,
    // so swapping regimes mid-scroll repeats or skips rows.
    //
    // The mirror serves the whole target set, not just a mailbox the reader has
    // singled out. It used to be gated on `accountIdParam !== "all"`, and every
    // default caller passes "all" — the list pane opens on it — so the indexed
    // keyset path that `idx_mail_metadata_list_keyset` exists for was unreachable
    // from the shipped UI, and the default inbox load was always a provider
    // fanout. The union is the same single index walk: the keyset index leads
    // with (org_id, user_membership_id, folder) and orders by (date DESC, id
    // DESC), with no account column in between.
    const metadataCursor = cursor ? decodeMetadataCursor(cursor, userId) : null;
    if (membershipId !== null) {
      if (metadataCursor !== null) {
        return this.pageFromMetadata(
          orgId, userId, membershipId, targetAccounts, folder, limit, query, metadataCursor,
        );
      }
      if (!cursor) {
        const page = await this.listFromMetadata(
          orgId, userId, membershipId, targetAccounts, folder, limit, query,
        );
        if (page) return page;
      }
    }

    const parsedCursor = cursor ? decodeCursor(cursor, userId) : {};
    const skipCache = Boolean(query);

    const settled = await Promise.allSettled(
      targetAccounts.map((acc) => this.fetchMessagesForAccount(orgId, userId, membershipId, acc, folder, limit, parsedCursor, query, skipCache)),
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
    // The incoming position of every account whose fetch REJECTED. It is carried
    // into the outgoing cursor verbatim: an account that is not in the cursor map
    // decodes on the next request as "no position yet" and replays from row zero,
    // so one transient provider error re-delivers that mailbox's first page in the
    // middle of a scroll — duplicate `accountId-id` keys, and every message
    // between its real position and the end silently unreachable.
    const carriedCursors: Array<{ accId: number; value: AccountCursorValue }> = [];

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
        const message = err instanceof Error ? err.message : "Failed to load messages";
        accountErrors.push({ accountId: acc.id, accountEmail: acc.accountEmail, message });
        if (err instanceof ComposioToolError && err.isAuthError) reauthAccountIds.push(acc.id);
        const carried = parsedCursor[acc.id];
        if (carried !== undefined) carriedCursors.push({ accId: acc.id, value: carried });
      }
    });

    // One awaited UPDATE for every mailbox whose grant just failed. The per-account
    // fire-and-forget form it replaces issued a write per row and dropped its rejection,
    // so a failed flag left the mailbox reading `active` with nothing logged.
    if (reauthAccountIds.length > 0) await this.accounts.markNeedsReauthMany(reauthAccountIds, orgId);

    const merged = mergeMessagesByDate(allMessages).slice(0, limit);
    const mergedIds = new Set(merged.map((m) => `${m.accountId}:${m.id}`));

    const nextCursorMap: OpaqueCursor = {};
    for (const fetch of accountFetches) {
      // Exhausted stays exhausted. Writing `undefined` here would be dropped by
      // JSON on the way out and read back as "no position yet".
      if (fetch.currentCursorValue === null) {
        nextCursorMap[fetch.accId] = null;
        continue;
      }
      const consumed = fetch.messages.filter((m) => mergedIds.has(`${m.accountId}:${m.id}`)).length;
      if (fetch.provider === "outlook") {
        if (!fetch.outlookHasMore && consumed === fetch.messages.length) {
          nextCursorMap[fetch.accId] = null;
        } else {
          const prevSkip = typeof fetch.currentCursorValue === "number" ? fetch.currentCursorValue : 0;
          nextCursorMap[fetch.accId] = prevSkip + consumed;
        }
      } else if (consumed === fetch.messages.length) {
        nextCursorMap[fetch.accId] = fetch.nextPageToken ?? null;
      } else {
        const prevToken = isPartialGmailCursor(fetch.currentCursorValue)
          ? fetch.currentCursorValue.token
          : typeof fetch.currentCursorValue === "string"
            ? fetch.currentCursorValue
            : "";
        const prevSkip = isPartialGmailCursor(fetch.currentCursorValue) ? fetch.currentCursorValue.skip : 0;
        nextCursorMap[fetch.accId] = consumed > 0
          ? { token: prevToken, skip: prevSkip + consumed }
          : fetch.currentCursorValue;
      }
    }

    // Applied after the fetch loop rather than inside it: an account is either
    // fulfilled or rejected, never both, so these keys never collide with one the
    // loop wrote. A carried non-null position also keeps `hasMore` true, so a
    // scroll whose only remaining mailbox errored can still be resumed instead of
    // ending on a failure the reader never chose.
    for (const carried of carriedCursors) nextCursorMap[carried.accId] = carried.value;

    const hasMore = Object.values(nextCursorMap).some((v) => v !== undefined && v !== null);
    const nextCursor = hasMore ? encodeCursor(nextCursorMap, userId) : null;

    return { messages: merged, nextCursor, accountErrors };
  }

  /**
   * Serve a page straight from `mail_message_metadata` when the local mirror is
   * fresh enough to answer it, with a keyset cursor so the scroll continues in
   * the database instead of dead-ending — this path used to return
   * `nextCursor: null` unconditionally, so a fresh cache capped the inbox at one
   * page and "load more" did nothing.
   *
   * Returning `null` means "the mirror cannot answer this" and the caller falls
   * through to the providers: a cold or stale mirror, or a search the mirror
   * does not match. The mirror only holds what has already been listed, so a
   * search miss here is inconclusive and the provider stays the authority.
   */
  /**
   * Page one from the mirror, or `null` to let the provider fanout answer.
   *
   * EVERY target mailbox has to be fresh, not just the one whose rows happen to
   * top the page. Freshness used to be read off the returned rows' `synced_at`,
   * which is sound for a single mailbox and wrong for a union: a mailbox that
   * syncs every minute would keep the page looking fresh while a second, stale
   * mailbox contributed nothing and stayed invisible to its owner. One indexed
   * probe over the whole set answers it instead, and a mailbox with no mirrored
   * rows at all is by definition not fresh, so a newly connected account always
   * falls through to the provider that will populate it.
   */
  private async listFromMetadata(
    orgId: string,
    userId: string,
    membershipId: number,
    accounts: MailAccount[],
    folder: MailFolder,
    limit: number,
    query: string | undefined,
  ): Promise<MailListResponse | null> {
    const accountIds = accounts.map((acc) => acc.id);
    const fresh = await this.metadata.freshAccountIds(orgId, accountIds, folder);
    if (fresh.length !== accountIds.length) return null;

    const cached = await this.metadata.listCached(membershipId, orgId, accountIds, folder, limit, query);
    if (!cached.hasData) return null;
    return this.metadataPageResponse(cached, accounts, userId);
  }

  /**
   * Continue a scroll already committed to the metadata regime. Freshness is not
   * re-checked: abandoning the regime halfway through re-delivers rows the caller
   * has seen, and the next page-one load re-checks it anyway. An exhausted page
   * ends the scroll here rather than falling through to the provider, where a
   * metadata cursor would decode as "no position" and replay page one.
   */
  private async pageFromMetadata(
    orgId: string,
    userId: string,
    membershipId: number,
    accounts: MailAccount[],
    folder: MailFolder,
    limit: number,
    query: string | undefined,
    after: MailMetadataCursor,
  ): Promise<MailListResponse> {
    const cached = await this.metadata.listCached(
      membershipId, orgId, accounts.map((acc) => acc.id), folder, limit, query, after,
    );
    return this.metadataPageResponse(cached, accounts, userId);
  }

  /**
   * `provider` is resolved per row. A union page can hold Gmail and Outlook rows
   * at once, and the client keys its reading pane and its actions off this field
   * — stamping one mailbox's provider onto every row sends a Graph message id
   * down the Gmail path.
   */
  private metadataPageResponse(
    cached: CachedMailPage,
    accounts: MailAccount[],
    userId: string,
  ): MailListResponse {
    const providerByAccount = new Map(accounts.map((acc) => [acc.id, acc.provider]));
    const fallbackProvider = accounts[0]?.provider ?? "gmail";
    return {
      messages: cached.messages.map((m) => ({
        id: m.messageId,
        threadId: m.threadId,
        accountId: m.accountId,
        provider: providerByAccount.get(m.accountId) ?? fallbackProvider,
        from: { email: m.senderEmail, name: m.senderName },
        to: [],
        subject: m.subject,
        snippet: "",
        date: m.date,
        isRead: m.isRead,
        isStarred: m.isStarred,
        hasAttachments: m.hasAttachment,
      } satisfies MailMessageSummary)),
      nextCursor: cached.nextCursor ? encodeMetadataCursor(cached.nextCursor, userId) : null,
      accountErrors: [],
    };
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
  ): Promise<{ messages: ReturnType<typeof mergeMessagesByDate>; nextPageToken: string | undefined; outlookHasMore: boolean }> {
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    const cursorValue = parsedCursor[acc.id];
    if (cursorValue === null) return { messages: [], nextPageToken: undefined, outlookHasMore: false };
    const cacheKey = `${folder}:${JSON.stringify(cursorValue ?? "")}:${query ?? ""}`;

    const fetcher = async () => {
      let result: { messages: ReturnType<typeof mergeMessagesByDate>; nextPageToken: string | undefined; outlookHasMore: boolean };
      if (acc.provider === "gmail") {
        let pageToken: string | undefined;
        let withinPageSkip = 0;
        if (isPartialGmailCursor(cursorValue)) {
          pageToken = cursorValue.token || undefined;
          withinPageSkip = cursorValue.skip;
        } else if (typeof cursorValue === "string") {
          pageToken = cursorValue;
        }
        const raw = await this.gmail.listMessages(userId, conn, folder, limit + withinPageSkip, pageToken, query);
        result = { messages: raw.messages.slice(withinPageSkip), nextPageToken: raw.nextPageToken ?? undefined, outlookHasMore: false };
      } else {
        const skip = typeof cursorValue === "number" ? cursorValue : 0;
        const raw = await this.outlook.listMessages(userId, conn, folder, limit, skip, query);
        result = { messages: raw.messages, nextPageToken: undefined, outlookHasMore: raw.nextSkip !== null && raw.nextSkip !== undefined };
      }

      if (!query && result.messages.length > 0 && membershipId !== null) {
        this.metadata.deferUpsertBatch(acc.id, membershipId, orgId, folder, result.messages);
        await this.checkpoints.savePosition(orgId, acc.id, folder, result.nextPageToken ?? null).catch((err: unknown) => {
          this.logger.error(`checkpoint save failed orgId=${orgId} accountId=${acc.id} folder=${folder}`, err instanceof Error ? err.stack : String(err));
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
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    try {
      if (acc.provider === "gmail") return await this.gmail.getMessage(userId, conn, messageId);
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
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    try {
      const messages = acc.provider === "gmail"
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
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    if (acc.provider === "gmail") {
      await this.gmail.sendEmail(userId, conn, to, subject, bodyHtml, cc, bcc);
    } else {
      await this.outlook.sendEmail(userId, conn, to, subject, bodyHtml, cc, bcc);
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
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    const requestedRecipient = to?.[0];
    if (acc.provider === "gmail") {
      if (!threadId) throw new BadRequestException("threadId is required for Gmail replies");
      let recipientEmail = requestedRecipient;
      if (!recipientEmail) {
        const original = await this.gmail.getMessage(userId, conn, messageId);
        recipientEmail = original.from.email !== acc.accountEmail
          ? original.from.email
          : original.to[0]?.email;
      }
      if (!recipientEmail) throw new BadRequestException("Cannot determine reply recipient: original message has no resolvable address");
      await this.gmail.replyToThread(userId, conn, { threadId, recipientEmail, bodyHtml, cc });
    } else {
      await this.outlook.replyToMessage(userId, conn, messageId, bodyHtml, cc, requestedRecipient);
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

    await this.cache.invalidateNamespace(`mail:messages:${acc.id}`);

    const stateUpdate: { isRead?: boolean; isStarred?: boolean; folder?: string } = {};
    if (action === "markRead") stateUpdate.isRead = true;
    else if (action === "markUnread") stateUpdate.isRead = false;
    else if (action === "star") stateUpdate.isStarred = true;
    else if (action === "unstar") stateUpdate.isStarred = false;
    else if (action === "archive") stateUpdate.folder = "archive";
    else if (action === "trash") stateUpdate.folder = "trash";

    if (Object.keys(stateUpdate).length > 0 && membershipId !== null) {
      this.metadata.deferUpdateState(acc.id, membershipId, orgId, messageId, stateUpdate);
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
    const acc = await this.accounts.assertOwnedConnection(orgId, userId, accountId);
    const conn: NormalizerConnectionMeta = { id: acc.id, composioAccountId: acc.composioConnectedAccountId, provider: acc.provider, accountEmail: acc.accountEmail };
    if (acc.provider === "gmail") {
      return this.gmail.getAttachment(userId, conn, messageId, attachmentId, fileName);
    }
    return this.outlook.getAttachment(userId, conn, messageId, attachmentId, fileName);
  }
}
