import { MailService } from "./mail.service";
import { MailAccountsService } from "./mail-accounts.service";
import { MailMetadataService } from "./mail-metadata.service";
import { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";
import { GmailMailProvider } from "./providers/gmail-mail.provider";
import { OutlookMailProvider } from "./providers/outlook-mail.provider";
import { CacheService } from "../../common/cache/cache.service";
import { decodeMetadataCursor } from "./providers/mail-metadata-cursor";
import type { CachedMailMessage } from "./mail-metadata.service";

const ORG = "org-regime";
const USER = "user-regime";
const MEMBERSHIP = 55;
const ACCOUNT = 7;

const GMAIL_ACCOUNT = {
  id: ACCOUNT,
  provider: "gmail" as const,
  accountEmail: "me@example.com",
  composioConnectedAccountId: "conn-1",
};

function cached(ids: number[]): CachedMailMessage[] {
  return ids.map((n) => ({
    messageId: `msg-${n}`,
    threadId: null,
    accountId: ACCOUNT,
    subject: `Subject ${n}`,
    senderEmail: "sender@example.com",
    senderName: "Sender",
    date: new Date(Date.UTC(2027, 0, n)).toISOString(),
    isRead: false,
    isStarred: false,
    hasAttachment: false,
    labels: null,
    folder: "inbox",
  }));
}

interface Harness {
  service: MailService;
  gmailList: jest.Mock;
  listCached: jest.Mock;
  isFresh: jest.Mock;
}

function makeHarness(
  metadataPages: Array<{
    messages: CachedMailMessage[];
    hasData: boolean;
    isFresh: boolean;
    nextCursor: { d: string | null; i: number } | null;
  }>,
  opts: { fresh?: boolean } = {},
): Harness {
  const listCached = jest.fn();
  for (const page of metadataPages) listCached.mockResolvedValueOnce(page);
  listCached.mockResolvedValue({ messages: [], hasData: false, isFresh: false, nextCursor: null });

  const isFresh = jest.fn().mockResolvedValue(opts.fresh ?? true);

  const gmailList = jest.fn().mockResolvedValue({ messages: [], nextPageToken: null });

  const accounts = {
    listAccounts: jest.fn().mockResolvedValue([GMAIL_ACCOUNT]),
    markNeedsReauth: jest.fn(),
  } as unknown as MailAccountsService;

  const metadata = {
    listCached,
    isFreshForAccount: isFresh,
    deferUpsertBatch: jest.fn(),
  } as unknown as MailMetadataService;

  const cache = {
    cachedVersioned: <T>(_ns: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;

  const service = new MailService(
    accounts,
    { listMessages: gmailList } as unknown as GmailMailProvider,
    { listMessages: jest.fn() } as unknown as OutlookMailProvider,
    cache,
    metadata,
    { savePosition: jest.fn().mockResolvedValue(undefined) } as unknown as MailSyncCheckpointService,
  );

  return { service, gmailList, listCached, isFresh };
}

describe("mail list — the cached page is pageable", () => {
  it("hands back a real cursor instead of dead-ending the scroll at one page", async () => {
    const h = makeHarness([
      { messages: cached([9, 8]), hasData: true, isFresh: true, nextCursor: { d: "2027-01-08T00:00:00.000Z", i: 8 } },
    ]);

    const page = await h.service.listMessages(ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 2);

    expect(page.messages.map((m) => m.id)).toEqual(["msg-9", "msg-8"]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeMetadataCursor(page.nextCursor as string, USER)).toEqual({
      d: "2027-01-08T00:00:00.000Z",
      i: 8,
    });
    expect(h.gmailList).not.toHaveBeenCalled();
  });

  it("BITE: continuing that cursor stays in the database and never re-enters the provider regime", async () => {
    const h = makeHarness([
      { messages: cached([9, 8]), hasData: true, isFresh: true, nextCursor: { d: "2027-01-08T00:00:00.000Z", i: 8 } },
      { messages: cached([7]), hasData: true, isFresh: false, nextCursor: null },
    ]);

    const first = await h.service.listMessages(ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 2);
    const second = await h.service.listMessages(
      ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 2, first.nextCursor ?? undefined,
    );

    expect(second.messages.map((m) => m.id)).toEqual(["msg-7"]);
    expect(second.nextCursor).toBeNull();
    expect(h.gmailList).not.toHaveBeenCalled();

    const resumed = h.listCached.mock.calls[1];
    expect(resumed?.[6]).toEqual({ d: "2027-01-08T00:00:00.000Z", i: 8 });
  });

  it("BITE: an exhausted metadata cursor ends the scroll rather than replaying page one from the provider", async () => {
    const h = makeHarness([
      { messages: cached([9]), hasData: true, isFresh: true, nextCursor: { d: "2027-01-09T00:00:00.000Z", i: 9 } },
      { messages: [], hasData: false, isFresh: false, nextCursor: null },
    ]);

    const first = await h.service.listMessages(ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 1);
    const second = await h.service.listMessages(
      ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 1, first.nextCursor ?? undefined,
    );

    expect(second.messages).toEqual([]);
    expect(second.nextCursor).toBeNull();
    expect(h.gmailList).not.toHaveBeenCalled();
  });

  it("still falls through to the provider when the mirror is stale", async () => {
    const h = makeHarness([
      { messages: cached([9]), hasData: true, isFresh: false, nextCursor: null },
    ]);

    await h.service.listMessages(ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 5);

    expect(h.gmailList).toHaveBeenCalledTimes(1);
  });
});

describe("mail list — search reaches the database", () => {
  it("passes the query through to listCached, which no caller ever did before", async () => {
    const h = makeHarness([
      { messages: cached([9]), hasData: true, isFresh: true, nextCursor: null },
    ]);

    const page = await h.service.listMessages(
      ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 5, undefined, "invoice",
    );

    expect(h.isFresh).toHaveBeenCalledWith(ORG, ACCOUNT, "inbox");
    expect(h.listCached).toHaveBeenCalledWith(MEMBERSHIP, ORG, ACCOUNT, "inbox", 5, "invoice");
    expect(page.messages.map((m) => m.id)).toEqual(["msg-9"]);
    expect(h.gmailList).not.toHaveBeenCalled();
  });

  it("BITE: a search that the mirror cannot answer is inconclusive, so the provider stays the authority", async () => {
    const h = makeHarness([
      { messages: [], hasData: false, isFresh: true, nextCursor: null },
    ]);

    await h.service.listMessages(
      ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 5, undefined, "needle",
    );

    expect(h.gmailList).toHaveBeenCalledTimes(1);
    expect(h.gmailList.mock.calls[0]?.[5]).toBe("needle");
  });

  it("does not search a stale mirror at all", async () => {
    const h = makeHarness([], { fresh: false });

    await h.service.listMessages(
      ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 5, undefined, "needle",
    );

    expect(h.listCached).not.toHaveBeenCalled();
    expect(h.gmailList).toHaveBeenCalledTimes(1);
  });
});

describe("mail list — the metadata regime is opt-in", () => {
  it("is skipped entirely for the all-accounts fan-out, which must merge across providers", async () => {
    const h = makeHarness([
      { messages: cached([9]), hasData: true, isFresh: true, nextCursor: null },
    ]);

    await h.service.listMessages(ORG, USER, MEMBERSHIP, "inbox", "all", 5);

    expect(h.listCached).not.toHaveBeenCalled();
    expect(h.gmailList).toHaveBeenCalledTimes(1);
  });

  it("is skipped when the caller has no membership, because the mirror is keyed on one", async () => {
    const h = makeHarness([
      { messages: cached([9]), hasData: true, isFresh: true, nextCursor: null },
    ]);

    await h.service.listMessages(ORG, USER, null, "inbox", String(ACCOUNT), 5);

    expect(h.listCached).not.toHaveBeenCalled();
    expect(h.gmailList).toHaveBeenCalledTimes(1);
  });

  it("BITE: a metadata cursor minted for another reader is rejected, not replayed as that reader's page", async () => {
    const h = makeHarness([
      { messages: cached([9]), hasData: true, isFresh: true, nextCursor: { d: "2027-01-09T00:00:00.000Z", i: 9 } },
    ]);

    const first = await h.service.listMessages(ORG, USER, MEMBERSHIP, "inbox", String(ACCOUNT), 1);
    expect(decodeMetadataCursor(first.nextCursor as string, "someone-else")).toBeNull();

    await h.service.listMessages(
      ORG, "someone-else", MEMBERSHIP, "inbox", String(ACCOUNT), 1, first.nextCursor ?? undefined,
    );

    expect(h.gmailList).toHaveBeenCalledTimes(1);
  });
});
