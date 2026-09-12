import { Logger } from "@nestjs/common";
import { CacheService } from "../../common/cache/cache.service";
import { GmailMailProvider } from "./providers/gmail-mail.provider";
import { OutlookMailProvider } from "./providers/outlook-mail.provider";
import {
  isPartialGmailCursor,
  mergeMessagesByDate,
  type NormalizerConnectionMeta,
  type OpaqueCursor,
} from "./providers/mail-normalizers";
import type { MailAccount } from "./mail-accounts.service";
import { MailMetadataService } from "./mail-metadata.service";
import { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";
import type { MailFolder } from "./dto/mail-schemas";

const CACHE_TTL_SECONDS = 45;
const logger = new Logger("MailFetchAccount");

export interface MailFetchDeps {
  gmail: GmailMailProvider;
  outlook: OutlookMailProvider;
  cache: CacheService;
  metadata: MailMetadataService;
  checkpoints: MailSyncCheckpointService;
}

export async function fetchMessagesForAccount(
  deps: MailFetchDeps,
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
  const { gmail, outlook, cache, metadata, checkpoints } = deps;
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
      const raw = await gmail.listMessages(
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
      const raw = await outlook.listMessages(
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
      metadata.deferUpsertBatch(
        acc.id,
        membershipId,
        orgId,
        folder,
        result.messages,
      );
      await checkpoints
        .savePosition(orgId, acc.id, folder, result.nextPageToken ?? null)
        .catch((err: unknown) => {
          logger.error(
            `checkpoint save failed orgId=${orgId} accountId=${acc.id} folder=${folder}`,
            err instanceof Error ? err.stack : String(err),
          );
        });
    }

    return result;
  };

  if (skipCache) return fetcher();
  return cache.cachedVersioned(
    `mail:messages:${acc.id}`,
    cacheKey,
    fetcher,
    CACHE_TTL_SECONDS,
  );
}
