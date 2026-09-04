import { encodeMetadataCursor, type MailMetadataCursor } from "./providers/mail-metadata-cursor";
import { MailMetadataService, type CachedMailPage } from "./mail-metadata.service";
import type { MailAccount } from "./mail-accounts.service";
import type { MailFolder, MailListResponse, MailMessageSummary } from "./dto/mail-schemas";

/**
 * Serving an inbox page from `mail_message_metadata` — the local mirror — rather
 * than from Gmail/Graph.
 *
 * This is the whole mirror regime: when the mirror may answer at all, how a
 * scroll already committed to it continues, and how a mirrored row becomes the
 * same `MailMessageSummary` the provider path returns. `MailService` owns the
 * other regime, the provider fanout, and the decision between them. Splitting
 * them keeps the freshness rules readable and lets them be exercised against a
 * `MailMetadataService` double with no provider in sight.
 */

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
export async function listFromMetadata(
  metadata: MailMetadataService,
  orgId: string,
  userId: string,
  membershipId: number,
  accounts: MailAccount[],
  folder: MailFolder,
  limit: number,
  query: string | undefined,
): Promise<MailListResponse | null> {
  const accountIds = accounts.map((acc) => acc.id);
  const fresh = await metadata.freshAccountIds(orgId, accountIds, folder);
  if (fresh.length !== accountIds.length) return null;

  const cached = await metadata.listCached(membershipId, orgId, accountIds, folder, limit, query);
  if (!cached.hasData) return null;
  return metadataPageResponse(cached, accounts, userId);
}

/**
 * Continue a scroll already committed to the metadata regime. Freshness is not
 * re-checked: abandoning the regime halfway through re-delivers rows the caller
 * has seen, and the next page-one load re-checks it anyway. An exhausted page
 * ends the scroll here rather than falling through to the provider, where a
 * metadata cursor would decode as "no position" and replay page one.
 */
export async function pageFromMetadata(
  metadata: MailMetadataService,
  orgId: string,
  userId: string,
  membershipId: number,
  accounts: MailAccount[],
  folder: MailFolder,
  limit: number,
  query: string | undefined,
  after: MailMetadataCursor,
): Promise<MailListResponse> {
  const cached = await metadata.listCached(
    membershipId, orgId, accounts.map((acc) => acc.id), folder, limit, query, after,
  );
  return metadataPageResponse(cached, accounts, userId);
}

/**
 * `provider` is resolved per row. A union page can hold Gmail and Outlook rows
 * at once, and the client keys its reading pane and its actions off this field
 * — stamping one mailbox's provider onto every row sends a Graph message id
 * down the Gmail path.
 */
export function metadataPageResponse(
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
