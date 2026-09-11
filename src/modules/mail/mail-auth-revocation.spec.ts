jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { NotFoundException } from "@nestjs/common";
import { MailService } from "./mail.service";
import { ComposioToolError } from "../integrations/core/composio.gateway";
import type { MailAccountsService, MailAccount } from "./mail-accounts.service";
import type { GmailMailProvider } from "./providers/gmail-mail.provider";
import type { OutlookMailProvider } from "./providers/outlook-mail.provider";
import type { CacheService } from "../../common/cache/cache.service";
import type { MailMetadataService } from "./mail-metadata.service";
import type { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";

/**
 * When Composio signals an auth error (token expired / user revoked OAuth),
 * the service must mark the account as needs_reauth so the UI can surface the
 * "reconnect" banner. The guard is MailService lines ~127, ~239, ~255.
 *
 * BITE PROOF: Remove either of the two `if (err instanceof ComposioToolError && err.isAuthError)`
 * arms from MailService and the "marks needs_reauth" assertions below will fail with
 * "Expected markNeedsReauth to have been called" (received 0 calls).
 *
 * The list fan-out flags every failing mailbox through `markNeedsReauthMany` in ONE awaited
 * write; the single-message paths still flag one account each through `markNeedsReauth`.
 */

const ORG_ID = "org-revoke";
const USER_ID = "user-revoke";

const ACTIVE_ACCOUNT: MailAccount = {
  id: 7,
  provider: "gmail",
  accountEmail: "me@gmail.com",
  accountLabel: null,
  status: "active",
  isPrimary: true,
  composioConnectedAccountId: "conn-revoke",
};

function makeAuthError(): ComposioToolError {
  return new ComposioToolError("token expired", true);
}

function makeNonAuthError(): ComposioToolError {
  return new ComposioToolError("rate limit exceeded", false);
}

function buildService(overrides: {
  listMessages?: jest.Mock;
  getMessage?: jest.Mock;
  getThread?: jest.Mock;
  accounts?: Partial<MailAccountsService>;
}): { service: MailService; markNeedsReauth: jest.Mock; markNeedsReauthMany: jest.Mock } {
  const markNeedsReauth = jest.fn().mockResolvedValue(undefined);
  const markNeedsReauthMany = jest.fn().mockResolvedValue(undefined);

  const accounts = {
    listAccounts: jest.fn().mockResolvedValue([ACTIVE_ACCOUNT]),
    markNeedsReauth,
    markNeedsReauthMany,
    assertOwnedConnection: jest.fn().mockResolvedValue(ACTIVE_ACCOUNT),
    ...overrides.accounts,
  } as unknown as MailAccountsService;

  const gmail = {
    listMessages: overrides.listMessages ?? jest.fn().mockResolvedValue({ messages: [], nextPageToken: null }),
    getMessage: overrides.getMessage ?? jest.fn().mockResolvedValue(null),
    getThread: overrides.getThread ?? jest.fn().mockResolvedValue([]),
  } as unknown as GmailMailProvider;

  const outlook = {} as unknown as OutlookMailProvider;

  const cache = {
    cachedVersioned: <T>(_ns: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;

  const metadata = {
    listCached: jest.fn().mockResolvedValue({ isFresh: false, hasData: false, messages: [] }),
    deferUpsertBatch: jest.fn(),
  } as unknown as MailMetadataService;

  const checkpoints = {
    savePosition: jest.fn().mockResolvedValue(undefined),
  } as unknown as MailSyncCheckpointService;

  const service = new MailService(accounts, gmail, outlook, cache, metadata, checkpoints, { ENCRYPTION_KEY: "mail-cursor-test-secret" });
  return { service, markNeedsReauth, markNeedsReauthMany };
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "k".repeat(64);
});

describe("MailService auth-error → markNeedsReauth (listMessages)", () => {
  it("marks the account needs_reauth when Gmail throws an auth error", async () => {
    const { service, markNeedsReauthMany } = buildService({
      listMessages: jest.fn().mockRejectedValue(makeAuthError()),
    });

    const result = await service.listMessages(ORG_ID, USER_ID, null, "inbox", "all", 10);

    expect(markNeedsReauthMany).toHaveBeenCalledTimes(1);
    expect(markNeedsReauthMany).toHaveBeenCalledWith([ACTIVE_ACCOUNT.id], ORG_ID);
    expect(result.accountErrors).toHaveLength(1);
    expect(result.accountErrors[0]?.accountId).toBe(ACTIVE_ACCOUNT.id);
    expect(result.messages).toHaveLength(0);
  });

  it("does NOT mark needs_reauth for a non-auth error from the provider", async () => {
    const { service, markNeedsReauth, markNeedsReauthMany } = buildService({
      listMessages: jest.fn().mockRejectedValue(makeNonAuthError()),
    });

    const result = await service.listMessages(ORG_ID, USER_ID, null, "inbox", "all", 10);

    expect(markNeedsReauth).not.toHaveBeenCalled();
    expect(markNeedsReauthMany).not.toHaveBeenCalled();
    expect(result.accountErrors).toHaveLength(1);
  });

  it("still returns messages from healthy accounts when one account has an auth error", async () => {
    const HEALTHY: MailAccount = { ...ACTIVE_ACCOUNT, id: 8, accountEmail: "other@gmail.com", composioConnectedAccountId: "conn-healthy" };
    const markNeedsReauthMany = jest.fn().mockResolvedValue(undefined);

    const accounts = {
      listAccounts: jest.fn().mockResolvedValue([ACTIVE_ACCOUNT, HEALTHY]),
      markNeedsReauthMany,
    } as unknown as MailAccountsService;

    let callCount = 0;
    const gmail = {
      listMessages: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(makeAuthError());
        return Promise.resolve({ messages: [{ id: "ok-1", threadId: null, accountId: HEALTHY.id, provider: "gmail", from: { name: null, email: "a@b.com" }, to: [], subject: "Hi", snippet: "", date: new Date().toISOString(), isRead: true, isStarred: false, hasAttachments: false }], nextPageToken: null });
      }),
    } as unknown as GmailMailProvider;

    const cache = {
      cachedVersioned: <T>(_ns: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
    } as unknown as CacheService;

    const metadata = {
      listCached: jest.fn().mockResolvedValue({ isFresh: false, hasData: false, messages: [] }),
      deferUpsertBatch: jest.fn(),
    } as unknown as MailMetadataService;

    const checkpoints = { savePosition: jest.fn().mockResolvedValue(undefined) } as unknown as MailSyncCheckpointService;
    const outlook = {} as unknown as OutlookMailProvider;

    const service = new MailService(accounts, gmail, outlook, cache, metadata, checkpoints, { ENCRYPTION_KEY: "mail-cursor-test-secret" });
    const result = await service.listMessages(ORG_ID, USER_ID, null, "inbox", "all", 10);

    expect(markNeedsReauthMany).toHaveBeenCalledWith([ACTIVE_ACCOUNT.id], ORG_ID);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe("ok-1");
    expect(result.accountErrors).toHaveLength(1);
    expect(result.accountErrors[0]?.accountId).toBe(ACTIVE_ACCOUNT.id);
  });
});

describe("MailService auth-error → markNeedsReauth (getMessage)", () => {
  it("marks needs_reauth and re-throws when getMessage receives an auth error", async () => {
    const { service, markNeedsReauth } = buildService({
      getMessage: jest.fn().mockRejectedValue(makeAuthError()),
    });

    await expect(
      service.getMessage(ORG_ID, USER_ID, "msg-1", ACTIVE_ACCOUNT.id),
    ).rejects.toBeInstanceOf(ComposioToolError);

    expect(markNeedsReauth).toHaveBeenCalledTimes(1);
    expect(markNeedsReauth).toHaveBeenCalledWith(ACTIVE_ACCOUNT.id, ORG_ID);
  });

  it("re-throws without marking needs_reauth for a non-auth provider error", async () => {
    const { service, markNeedsReauth } = buildService({
      getMessage: jest.fn().mockRejectedValue(makeNonAuthError()),
    });

    await expect(
      service.getMessage(ORG_ID, USER_ID, "msg-1", ACTIVE_ACCOUNT.id),
    ).rejects.toBeInstanceOf(ComposioToolError);

    expect(markNeedsReauth).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the account does not belong to the user", async () => {
    const accounts = {
      assertOwnedConnection: jest.fn().mockRejectedValue(new NotFoundException("Mail account not found")),
      markNeedsReauth: jest.fn(),
    } as unknown as MailAccountsService;

    const gmail = {} as unknown as GmailMailProvider;
    const outlook = {} as unknown as OutlookMailProvider;
    const cache = {} as unknown as CacheService;
    const metadata = {} as unknown as MailMetadataService;
    const checkpoints = {} as unknown as MailSyncCheckpointService;

    const service = new MailService(accounts, gmail, outlook, cache, metadata, checkpoints, { ENCRYPTION_KEY: "mail-cursor-test-secret" });

    await expect(
      service.getMessage(ORG_ID, USER_ID, "msg-1", 999),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("MailService auth-error → markNeedsReauth (getThread)", () => {
  it("marks needs_reauth and re-throws when getThread receives an auth error", async () => {
    const { service, markNeedsReauth } = buildService({
      getThread: jest.fn().mockRejectedValue(makeAuthError()),
    });

    await expect(
      service.getThread(ORG_ID, USER_ID, "thread-1", ACTIVE_ACCOUNT.id),
    ).rejects.toBeInstanceOf(ComposioToolError);

    expect(markNeedsReauth).toHaveBeenCalledTimes(1);
    expect(markNeedsReauth).toHaveBeenCalledWith(ACTIVE_ACCOUNT.id, ORG_ID);
  });

  it("does NOT mark needs_reauth for a non-auth provider error in getThread", async () => {
    const { service, markNeedsReauth } = buildService({
      getThread: jest.fn().mockRejectedValue(makeNonAuthError()),
    });

    await expect(
      service.getThread(ORG_ID, USER_ID, "thread-1", ACTIVE_ACCOUNT.id),
    ).rejects.toBeInstanceOf(ComposioToolError);

    expect(markNeedsReauth).not.toHaveBeenCalled();
  });
});
