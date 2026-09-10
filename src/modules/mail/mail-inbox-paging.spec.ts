jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { MailService } from "./mail.service";
import type { MailAccountsService, MailAccount } from "./mail-accounts.service";
import type { MailMetadataService } from "./mail-metadata.service";
import type { GmailMailProvider } from "./providers/gmail-mail.provider";
import type { OutlookMailProvider } from "./providers/outlook-mail.provider";
import type { CacheService } from "../../common/cache/cache.service";
import type { MailFolder, MailMessageSummary } from "./dto/mail-schemas";

/**
 * A merged two-account inbox slices globally, so a page can consume four of
 * Gmail's ten rows and six of Outlook's. Advancing each provider's cursor to the
 * end of what it *fetched* rather than what it *returned* drops the other six
 * permanently — one page of each account lost on every scroll.
 *
 * The property under test is the same one chat has: page the inbox and every
 * message that existed at the start comes back exactly once. The providers here
 * alternate by date so every page straddles both.
 */

/* The cursor signer takes its key from config now, so the harness states it. */
const CURSOR_SECRET = "k".repeat(64);

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

/** Alternating minutes, newest first, so a merged page always straddles both. */
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
  readonly gmailPageSizes: number[];
}

/**
 * Gmail pages by opaque token, Outlook by numeric skip — both are modelled here
 * the way the providers actually behave, including Gmail's page tokens being
 * fixed-size windows the service must be able to resume inside.
 */
function buildHarness(
  gmailBox: MailMessageSummary[],
  outlookBox: MailMessageSummary[],
  gmailPageSize: number,
): Harness {
  const gmailPageSizes: number[] = [];

  const gmail = {
    listMessages: jest
      .fn()
      .mockImplementation(
        (_userId: string, _conn: unknown, _folder: MailFolder, limit: number, pageToken?: string) => {
          gmailPageSizes.push(limit);
          const start = pageToken ? Number(pageToken) : 0;
          const window = gmailBox.slice(start, start + gmailPageSize);
          const nextStart = start + gmailPageSize;
          return Promise.resolve({
            messages: window,
            nextPageToken: nextStart < gmailBox.length ? String(nextStart) : null,
          });
        },
      ),
  } as unknown as GmailMailProvider;

  const outlook = {
    listMessages: jest
      .fn()
      .mockImplementation(
        (_userId: string, _conn: unknown, _folder: MailFolder, limit: number, skip: number) => {
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
  } as unknown as MailAccountsService;

  const metadata = {
    listCached: jest.fn().mockResolvedValue({ isFresh: false, hasData: false, messages: [] }),
    deferUpsertBatch: jest.fn(),
  } as unknown as MailMetadataService;

  const cache = {
    cachedVersioned: <T>(_ns: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;

  return {
    service: new MailService(accounts, gmail, outlook, cache, metadata, {
      ENCRYPTION_KEY: CURSOR_SECRET,
    }),
    gmailPageSizes,
  };
}

async function pageThrough(harness: Harness, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    const page = await harness.service.listMessages(ORG_ID, USER_ID, FOLDER, "all", limit, cursor);
    pages++;
    seen.push(...page.messages.map((m) => `${m.accountId}:${m.id}`));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    if (pages > 50) throw new Error("paging did not terminate");
  }

  return seen;
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

describe("multi-account inbox paging", () => {

  it("returns every message from both providers exactly once", async () => {
    const { gmail, outlook } = buildMailboxes(12);
    const harness = buildHarness(gmail, outlook, 10);

    const seen = await pageThrough(harness, 8);

    expect(duplicates(seen)).toEqual([]);
    const expected = [
      ...gmail.map((m) => `${m.accountId}:${m.id}`),
      ...outlook.map((m) => `${m.accountId}:${m.id}`),
    ].sort();
    expect([...seen].sort()).toEqual(expected);
  });

  it("never advances past rows it fetched but did not return", async () => {
    const { gmail, outlook } = buildMailboxes(12);
    const harness = buildHarness(gmail, outlook, 10);

    const first = await harness.service.listMessages(ORG_ID, USER_ID, FOLDER, "all", 8, undefined);
    expect(first.messages).toHaveLength(8);
    expect(first.nextCursor).not.toBeNull();

    const second = await harness.service.listMessages(
      ORG_ID,
      USER_ID,
      FOLDER,
      "all",
      8,
      first.nextCursor ?? undefined,
    );

    const firstKeys = first.messages.map((m) => `${m.accountId}:${m.id}`);
    const secondKeys = second.messages.map((m) => `${m.accountId}:${m.id}`);
    expect(duplicates([...firstKeys, ...secondKeys])).toEqual([]);

    const merged = [...gmail, ...outlook].sort((a, b) => b.date.localeCompare(a.date));
    expect(secondKeys).toEqual(merged.slice(8, 16).map((m) => `${m.accountId}:${m.id}`));
  });

  it("resumes inside a partially consumed Gmail page by over-fetching the skip", async () => {
    const { gmail, outlook } = buildMailboxes(12);
    const harness = buildHarness(gmail, outlook, 10);

    const first = await harness.service.listMessages(ORG_ID, USER_ID, FOLDER, "all", 8, undefined);
    await harness.service.listMessages(ORG_ID, USER_ID, FOLDER, "all", 8, first.nextCursor ?? undefined);

    const [firstAsk, secondAsk] = harness.gmailPageSizes;
    expect(firstAsk).toBe(8);
    expect(secondAsk).toBeGreaterThan(8);
  });

  it("keeps an exhausted account exhausted across the wire", async () => {
    // Outlook runs dry first: 4 messages against Gmail's 12. Marking it done with
    // `undefined` used to vanish in JSON.stringify, so the next page read it as
    // "no position yet" and replayed the whole mailbox.
    const { gmail } = buildMailboxes(12);
    const { outlook } = buildMailboxes(4);
    const harness = buildHarness(gmail, outlook.slice(0, 4), 10);

    const seen = await pageThrough(harness, 6);

    expect(duplicates(seen)).toEqual([]);
    expect(seen.filter((key) => key.startsWith(`${OUTLOOK_ACCOUNT.id}:`))).toHaveLength(4);
  });

  it("stops with no cursor once both mailboxes are exhausted", async () => {
    const { gmail, outlook } = buildMailboxes(3);
    const harness = buildHarness(gmail, outlook, 10);

    const page = await harness.service.listMessages(ORG_ID, USER_ID, FOLDER, "all", 20, undefined);

    expect(page.messages).toHaveLength(6);
    expect(page.nextCursor).toBeNull();
  });

  it("hands a page to the first-page reader when the cursor is unreadable", async () => {
    const { gmail, outlook } = buildMailboxes(12);
    const harness = buildHarness(gmail, outlook, 10);

    const first = await harness.service.listMessages(ORG_ID, USER_ID, FOLDER, "all", 8, undefined);
    const junk = await harness.service.listMessages(ORG_ID, USER_ID, FOLDER, "all", 8, "m1.garbage.signature");

    expect(junk.messages.map((m) => m.id)).toEqual(first.messages.map((m) => m.id));
  });

  it("ignores a cursor minted for another reader", async () => {
    const { gmail, outlook } = buildMailboxes(12);
    const harness = buildHarness(gmail, outlook, 10);

    const first = await harness.service.listMessages(ORG_ID, USER_ID, FOLDER, "all", 8, undefined);
    const replayed = await harness.service.listMessages(
      ORG_ID,
      "someone-else",
      FOLDER,
      "all",
      8,
      first.nextCursor ?? undefined,
    );

    expect(replayed.messages.map((m) => m.id)).toEqual(first.messages.map((m) => m.id));
  });
});
