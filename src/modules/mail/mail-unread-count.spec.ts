jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { MailService } from "./mail.service";
import { MailMetadataService } from "./mail-metadata.service";
import type { Db } from "../../db/drizzle.module";
import type { MailAccountsService, MailAccount } from "./mail-accounts.service";
import type { GmailMailProvider } from "./providers/gmail-mail.provider";
import type { OutlookMailProvider } from "./providers/outlook-mail.provider";
import type { CacheService } from "../../common/cache/cache.service";
import type { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";

/**
 * The unread badge is rendered by every authenticated page. It used to be
 * derived by listing 100 messages per connected mailbox out of Gmail/Graph over
 * HTTP and counting `!isRead` in JavaScript — no query, no index, and a provider
 * fanout on every page load. `mail_message_metadata` already mirrors exactly the
 * rows being counted.
 */

const dialect = new PgDialect();
const ORG = "org-unread";
const USER = "user-1";
const MEMBERSHIP = 42;

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

function renderWhere(pred: SQL | undefined): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(pred as SQL);
  return { sql, params: [...params] };
}

describe("MailMetadataService.countUnread — the query that did not exist", () => {
  it("counts in the database against (org, membership, folder, account) with is_read = false", async () => {
    let capturedWhere: SQL | undefined;
    const where = jest.fn().mockImplementation((pred: SQL) => {
      capturedWhere = pred;
      return Promise.resolve([{ cnt: 7 }]);
    });
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;

    const unread = await new MailMetadataService(db).countUnread(ORG, MEMBERSHIP, "inbox", [1, 2]);

    expect(unread).toBe(7);
    const { sql, params } = renderWhere(capturedWhere);
    expect(sql).toContain("count");
    expect(sql).toContain("org_id");
    expect(sql).toContain("user_membership_id");
    expect(sql).toContain("folder");
    expect(sql).toContain("is_read");
    expect(sql).toContain("account_id");
    expect(params).toEqual(expect.arrayContaining([ORG, MEMBERSHIP, "inbox", false, 1, 2]));
  });

  it("BITE: narrows to the live account list, so a disconnected mailbox's mirrored rows stop counting", async () => {
    const where = jest.fn().mockResolvedValue([{ cnt: 0 }]);
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;

    const unread = await new MailMetadataService(db).countUnread(ORG, MEMBERSHIP, "inbox", []);

    expect(unread).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });
});

interface Harness {
  readonly service: MailService;
  readonly gmailList: jest.Mock;
  readonly outlookList: jest.Mock;
  readonly countUnread: jest.Mock;
  readonly freshAccountIds: jest.Mock;
}

function buildHarness(freshIds: number[], mirrorCount: number, accounts: MailAccount[]): Harness {
  const gmailList = jest.fn().mockResolvedValue({ messages: [], nextPageToken: null });
  const outlookList = jest.fn().mockResolvedValue({ messages: [], nextSkip: null });
  const countUnread = jest.fn().mockResolvedValue(mirrorCount);
  const freshAccountIds = jest.fn().mockResolvedValue(freshIds);

  const service = new MailService(
    {
      listAccounts: jest.fn().mockResolvedValue(accounts),
      markNeedsReauthMany: jest.fn().mockResolvedValue(undefined),
    } as unknown as MailAccountsService,
    { listMessages: gmailList } as unknown as GmailMailProvider,
    { listMessages: outlookList } as unknown as OutlookMailProvider,
    {
      cachedVersioned: <T>(_ns: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
    } as unknown as CacheService,
    {
      countUnread,
      freshAccountIds,
      listCached: jest.fn().mockResolvedValue({ hasData: false, isFresh: false, messages: [], nextCursor: null }),
      isFreshForAccount: jest.fn().mockResolvedValue(false),
      deferUpsertBatch: jest.fn(),
    } as unknown as MailMetadataService,
    { savePosition: jest.fn().mockResolvedValue(undefined) } as unknown as MailSyncCheckpointService,
    { ENCRYPTION_KEY: "mail-cursor-test-secret" },
  );

  return { service, gmailList, outlookList, countUnread, freshAccountIds };
}

describe("MailService.countUnread", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "k".repeat(64);
  });

  it("BITE: with every mailbox fresh, the badge is one indexed count and touches NO provider", async () => {
    const harness = buildHarness([1, 2], 5, [GMAIL_ACCOUNT, OUTLOOK_ACCOUNT]);

    const result = await harness.service.countUnread(ORG, USER, MEMBERSHIP, "inbox", 100);

    expect(result).toEqual({ unread: 5, exact: true });
    expect(harness.countUnread).toHaveBeenCalledWith(ORG, MEMBERSHIP, "inbox", [1, 2]);
    expect(harness.gmailList).not.toHaveBeenCalled();
    expect(harness.outlookList).not.toHaveBeenCalled();
  });

  it("asks about every account in ONE query, not one query per mailbox", async () => {
    const harness = buildHarness([1, 2], 5, [GMAIL_ACCOUNT, OUTLOOK_ACCOUNT]);

    await harness.service.countUnread(ORG, USER, MEMBERSHIP, "inbox", 100);

    expect(harness.freshAccountIds).toHaveBeenCalledTimes(1);
    expect(harness.freshAccountIds).toHaveBeenCalledWith(ORG, [1, 2], "inbox");
  });

  it("falls through to the providers when a mailbox's mirror is stale", async () => {
    const harness = buildHarness([1], 5, [GMAIL_ACCOUNT, OUTLOOK_ACCOUNT]);

    const result = await harness.service.countUnread(ORG, USER, MEMBERSHIP, "inbox", 100);

    expect(harness.countUnread).not.toHaveBeenCalled();
    expect(harness.gmailList).toHaveBeenCalled();
    expect(harness.outlookList).toHaveBeenCalled();
    expect(result).toEqual({ unread: 0, exact: true });
  });

  it("falls through to the providers for a principal with no membership", async () => {
    const harness = buildHarness([1, 2], 5, [GMAIL_ACCOUNT, OUTLOOK_ACCOUNT]);

    await harness.service.countUnread(ORG, USER, null, "inbox", 100);

    expect(harness.countUnread).not.toHaveBeenCalled();
    expect(harness.gmailList).toHaveBeenCalled();
  });

  it("answers zero exactly when nothing is connected, without asking anything", async () => {
    const harness = buildHarness([], 0, []);

    const result = await harness.service.countUnread(ORG, USER, MEMBERSHIP, "inbox", 100);

    expect(result).toEqual({ unread: 0, exact: true });
    expect(harness.freshAccountIds).not.toHaveBeenCalled();
    expect(harness.countUnread).not.toHaveBeenCalled();
    expect(harness.gmailList).not.toHaveBeenCalled();
  });
});
