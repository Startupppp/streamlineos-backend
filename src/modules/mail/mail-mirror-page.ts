import {
  encodeMetadataCursor,
  type MailMetadataCursor,
} from "./providers/mail-metadata-cursor";
import {
  MailMetadataService,
  type CachedMailPage,
} from "./mail-metadata.service";
import type { MailAccount } from "./mail-accounts.service";
import type {
  MailListResponse,
  MailMessageSummary,
} from "./dto/mail-response.schemas";
import type { MailFolder } from "./dto/mail-schemas";

export async function listFromMetadata(
  metadata: MailMetadataService,
  orgId: string,
  userId: string,
  membershipId: number,
  accounts: MailAccount[],
  folder: MailFolder,
  limit: number,
  query: string | undefined,
  unreadOnly?: boolean,
): Promise<MailListResponse | null> {
  const accountIds = accounts.map((acc) => acc.id);
  const fresh = await metadata.freshAccountIds(orgId, accountIds, folder);
  if (fresh.length !== accountIds.length) return null;

  const cached = await metadata.listCached(
    membershipId,
    orgId,
    accountIds,
    folder,
    limit,
    query,
    undefined,
    unreadOnly,
  );
  if (!cached.hasData) return null;
  return metadataPageResponse(cached, accounts, userId);
}

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
  unreadOnly?: boolean,
): Promise<MailListResponse> {
  const cached = await metadata.listCached(
    membershipId,
    orgId,
    accounts.map((acc) => acc.id),
    folder,
    limit,
    query,
    after,
    unreadOnly,
  );
  return metadataPageResponse(cached, accounts, userId);
}

export function metadataPageResponse(
  cached: CachedMailPage,
  accounts: MailAccount[],
  userId: string,
): MailListResponse {
  const providerByAccount = new Map(
    accounts.map((acc) => [acc.id, acc.provider]),
  );
  const fallbackProvider = accounts[0]?.provider ?? "gmail";
  return {
    messages: cached.messages.map(
      (m) =>
        ({
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
        }) satisfies MailMessageSummary,
    ),
    nextCursor: cached.nextCursor
      ? encodeMetadataCursor(cached.nextCursor, userId)
      : null,
    accountErrors: [],
  };
}
