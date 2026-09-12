jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { MailService } from "./mail.service";
import { decodeCursor } from "./providers/mail-normalizers";
import type { MailAccountsService, MailAccount } from "./mail-accounts.service";
import type { MailMetadataService } from "./mail-metadata.service";
import type { GmailMailProvider } from "./providers/gmail-mail.provider";
import type { OutlookMailProvider } from "./providers/outlook-mail.provider";
import type { CacheService } from "../../common/cache/cache.service";
import type { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";
import type { MailMessageSummary } from "./dto/mail-response.schemas";
import type { MailFolder } from "./dto/mail-schemas";

/**
 * A provider that errors mid-scroll must not lose its reader's place.
 *
 * `listMessages` builds the outgoing cursor from the accounts that FULFILLED, so
 * an account whose fetch rejected got no entry at all. The next request decodes
 * that absence as "no position yet" and restarts that mailbox from row zero: the
 * reader sees its first page a second time, with duplicate `accountId:id` keys,
 * and everything between its real position and the end of the mailbox becomes
 * unreachable for the rest of the scroll. One transient 503 is enough.
 */

const ORG_ID = "org-1";
const USER_ID = "user-1";
const FOLDER: MailFolder = "inbox";

const GMAIL_ACCOUNT: MailAccount = {
  id: 1,
  provider: "gmail",
  accountEmail: "a@example.test",
  accountLabel: "Gmail",
  status: "active",
  isPrimary: true,
  composioConnectedAccountId: "conn-gmail",
};

const OUTLOOK_ACCOUNT: MailAccount = {
  id: 2,
  provider: "outlook",
  accountEmail: "b@example.test",
  accountLabel: "Outlook",
  status: "active",
  isPrimary: false,
  composioConnectedAccountId: "conn-outlook",
};

function summary(accountId: number, provider: "gmail" | "outlook", index: number, iso: string): MailMessageSummary {
  return {
    id: `${provider}-${index}`,
    threadId: `${provider}-t${index}`,
    accountId,
    provider,
    from: { email: "sender@example.test", name: "Sender" },
    to: [],
    subject: `${provider} ${index}`,
    snippet: "",
    date: iso,
    isRead: false,
    isStarred: false,
    hasAttachments: false,
  };
}

function buildMailboxes(perAccount: number): { gmail: MailMessageSummary[]; outlook: MailMessageSummary[] } {
  const gmail: MailMessageSummary[] = [];
  const outlook: MailMessageSummary[] = [];
  for (let i = 0; i < perAccount; i++) {
    gmail.push(summary(GMAIL_ACCOUNT.id, "gmail", i, new Date(Date.UTC(2024, 0, 1, 12, 0, perAccount * 2 - i * 2)).toISOString()));
    outlook.push(summary(OUTLOOK_ACCOUNT.id, "outlook", i, new Date(Date.UTC(2024, 0, 1, 12, 0, perAccount * 2 - i * 2 - 1)).toISOString()));
  }
  return { gmail, outlook };
}

interface Harness {
  readonly service: MailService;
  /** Fail the next Outlook fetch, once. */
  failOutlookOnce(): void;
  readonly outlookSkips: number[];
}

function buildHarness(
  gmailBox: MailMessageSummary[],
  outlookBox: MailMessageSummary[],
  gmailPageSize: number,
): Harness {
  let outlookFailures = 0;
  const outlookSkips: number[] = [];

  const gmail = {
    listMessages: jest.fn().mockImplementation(
      (_userId: string, _conn: unknown, _folder: MailFolder, limit: number, pageToken?: string) => {
        const start = pageToken ? Number(pageToken) : 0;
        const window = gmailBox.slice(start, start + Math.max(gmailPageSize, limit));
        const nextStart = start + window.length;
        return Promise.resolve({
          messages: window,
          nextPageToken: nextStart < gmailBox.length ? String(nextStart) : null,
        });
      },
    ),
  } as unknown as GmailMailProvider;

  const outlook = {
    listMessages: jest.fn().mockImplementation(
      (_userId: string, _conn: unknown, _folder: MailFolder, limit: number, skip: number) => {
        if (outlookFailures > 0) {
          outlookFailures--;
          return Promise.reject(new Error("Graph is having a moment"));
        }
        outlookSkips.push(skip);
        const window = outlookBox.slice(skip, skip + limit);
        const nextSkip = skip + window.length;
        return Promise.resolve({
          messages: window,
          nextSkip: nextSkip < outlookBox.length ? nextSkip : null,
        });
      },
    ),
  } as unknown as OutlookMailProvider;

  const accounts = {
    listAccounts: jest.fn().mockResolvedValue([GMAIL_ACCOUNT, OUTLOOK_ACCOUNT]),
    markNeedsReauth: jest.fn(),
    markNeedsReauthMany: jest.fn().mockResolvedValue(undefined),
  } as unknown as MailAccountsService;

  const metadata = {
    listCached: jest.fn().mockResolvedValue({ isFresh: false, hasData: false, messages: [] }),
    isFreshForAccount: jest.fn().mockResolvedValue(false),
    deferUpsertBatch: jest.fn(),
  } as unknown as MailMetadataService;

  const cache = {
    cachedVersioned: <T>(_ns: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;

  const checkpoints = {
    savePosition: jest.fn().mockResolvedValue(undefined),
  } as unknown as MailSyncCheckpointService;

  return {
    service: new MailService(accounts, gmail, outlook, cache, metadata, checkpoints, { ENCRYPTION_KEY: "mail-cursor-test-secret" }),
    failOutlookOnce: () => {
      outlookFailures = 1;
    },
    outlookSkips,
  };
}

function duplicates(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) repeated.add(key);
    seen.add(key);
  }
  return [...repeated].sort();
}

describe("multi-account inbox paging — an account that errors mid-scroll", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "k".repeat(64);
  });

  it("BITE: carries the failed account's incoming position into the outgoing cursor", async () => {
    const { gmail, outlook } = buildMailboxes(12);
    const harness = buildHarness(gmail, outlook, 10);

    const first = await harness.service.listMessages(ORG_ID, USER_ID, null, FOLDER, "all", 8, undefined);
    expect(first.nextCursor).not.toBeNull();
    const afterFirst = decodeCursor(first.nextCursor ?? "", USER_ID, "mail-cursor-test-secret");
    expect(afterFirst[OUTLOOK_ACCOUNT.id]).toBe(4);

    harness.failOutlookOnce();
    const second = await harness.service.listMessages(
      ORG_ID, USER_ID, null, FOLDER, "all", 8, first.nextCursor ?? undefined,
    );

    expect(second.accountErrors.map((e) => e.accountId)).toEqual([OUTLOOK_ACCOUNT.id]);
    expect(second.nextCursor).not.toBeNull();
    const afterSecond = decodeCursor(second.nextCursor ?? "", USER_ID, "mail-cursor-test-secret");
    expect(afterSecond[OUTLOOK_ACCOUNT.id]).toBe(afterFirst[OUTLOOK_ACCOUNT.id]);
  });

  it("BITE: the mailbox resumes where it was, so the failed page does not re-deliver its first page", async () => {
    const { gmail, outlook } = buildMailboxes(12);
    const harness = buildHarness(gmail, outlook, 10);

    const first = await harness.service.listMessages(ORG_ID, USER_ID, null, FOLDER, "all", 8, undefined);
    harness.failOutlookOnce();
    const second = await harness.service.listMessages(
      ORG_ID, USER_ID, null, FOLDER, "all", 8, first.nextCursor ?? undefined,
    );
    const third = await harness.service.listMessages(
      ORG_ID, USER_ID, null, FOLDER, "all", 8, second.nextCursor ?? undefined,
    );

    const keys = [...first.messages, ...second.messages, ...third.messages].map(
      (m) => `${m.accountId}:${m.id}`,
    );
    expect(duplicates(keys)).toEqual([]);
    expect(harness.outlookSkips).toEqual([0, 4]);
  });

  it("does not end the scroll when the only mailbox with more to give errors", async () => {
    // Gmail runs dry at 4; Outlook still holds 12. If the failed account's
    // position is dropped, `hasMore` goes false and the reader's scroll ends on
    // an error they never chose, with eight messages they can no longer reach.
    const { gmail } = buildMailboxes(4);
    const { outlook } = buildMailboxes(12);
    const harness = buildHarness(gmail.slice(0, 4), outlook, 10);

    const first = await harness.service.listMessages(ORG_ID, USER_ID, null, FOLDER, "all", 8, undefined);
    harness.failOutlookOnce();
    const second = await harness.service.listMessages(
      ORG_ID, USER_ID, null, FOLDER, "all", 8, first.nextCursor ?? undefined,
    );

    expect(second.accountErrors).toHaveLength(1);
    expect(second.nextCursor).not.toBeNull();
  });

  it("an account that fails on page one is simply retried from the start", async () => {
    const { gmail, outlook } = buildMailboxes(12);
    const harness = buildHarness(gmail, outlook, 10);

    harness.failOutlookOnce();
    const first = await harness.service.listMessages(ORG_ID, USER_ID, null, FOLDER, "all", 8, undefined);

    expect(first.accountErrors).toHaveLength(1);
    const afterFirst = decodeCursor(first.nextCursor ?? "", USER_ID, "mail-cursor-test-secret");
    expect(afterFirst[OUTLOOK_ACCOUNT.id]).toBeUndefined();

    const second = await harness.service.listMessages(
      ORG_ID, USER_ID, null, FOLDER, "all", 8, first.nextCursor ?? undefined,
    );
    expect(harness.outlookSkips).toEqual([0]);
    expect(second.messages.some((m) => m.accountId === OUTLOOK_ACCOUNT.id)).toBe(true);
  });
});
