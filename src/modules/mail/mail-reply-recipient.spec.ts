import { BadRequestException } from "@nestjs/common";
import { MailService } from "./mail.service";
import type { GmailMailProvider } from "./providers/gmail-mail.provider";
import type { OutlookMailProvider } from "./providers/outlook-mail.provider";
import type { MailAccountsService, MailAccount } from "./mail-accounts.service";
import type { CacheService } from "../../common/cache/cache.service";
import type { MailMetadataService } from "./mail-metadata.service";
import type { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";
import type { MailMessageDetail } from "./dto/mail-schemas";

const ACCOUNT_EMAIL = "me@example.com";

const mockAccount: MailAccount = {
  id: 1,
  provider: "gmail",
  accountEmail: ACCOUNT_EMAIL,
  accountLabel: null,
  composioConnectedAccountId: "conn-1",
  status: "active",
  isPrimary: true,
};

function makeDetail(overrides: Partial<MailMessageDetail> = {}): MailMessageDetail {
  return {
    id: "msg-id-abc",
    threadId: "thread-123",
    accountId: 1,
    provider: "gmail",
    from: { email: "sender@example.com", name: "Sender" },
    to: [{ email: "recipient@example.com", name: null }],
    cc: [],
    subject: "Test Subject",
    snippet: "",
    date: new Date().toISOString(),
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    bodyHtml: null,
    bodyText: null,
    attachments: [],
    ...overrides,
  };
}

describe("MailService.replyMail — Gmail recipient resolution", () => {
  let service: MailService;
  const assertOwnedConnection = jest.fn();
  const getMessage = jest.fn();
  const replyToThread = jest.fn();

  const gmail = { getMessage, replyToThread } as unknown as GmailMailProvider;
  const accounts = { assertOwnedConnection } as unknown as MailAccountsService;
  const outlook = {} as unknown as OutlookMailProvider;
  const cache = {} as unknown as CacheService;
  const metadata = {} as unknown as MailMetadataService;
  const checkpoints = {} as unknown as MailSyncCheckpointService;

  beforeEach(() => {
    jest.resetAllMocks();
    assertOwnedConnection.mockResolvedValue(mockAccount);
    replyToThread.mockResolvedValue(undefined);
    service = new MailService(accounts, gmail, outlook, cache, metadata, checkpoints);
  });

  it("sends reply to the original sender email address, NOT the messageId", async () => {
    getMessage.mockResolvedValue(
      makeDetail({ from: { email: "sender@example.com", name: "Sender" } }),
    );

    await service.replyMail("org-1", "user-1", 1, "msg-id-abc", "thread-123", "<p>Reply</p>", []);

    expect(replyToThread).toHaveBeenCalledTimes(1);
    const [, , opts] = replyToThread.mock.calls[0] as [unknown, unknown, { threadId: string; recipientEmail: string }];
    expect(opts.recipientEmail).toBe("sender@example.com");
    expect(opts.recipientEmail).not.toBe("msg-id-abc");
  });

  it("sends reply to the first To address when replying to own sent message", async () => {
    getMessage.mockResolvedValue(
      makeDetail({
        from: { email: ACCOUNT_EMAIL, name: "Me" },
        to: [{ email: "actual-recipient@example.com", name: null }],
      }),
    );

    await service.replyMail("org-1", "user-1", 1, "msg-id-abc", "thread-123", "<p>Reply</p>", []);

    const [, , opts] = replyToThread.mock.calls[0] as [unknown, unknown, { recipientEmail: string }];
    expect(opts.recipientEmail).toBe("actual-recipient@example.com");
  });

  it("throws BadRequestException when own sent message has no To recipients", async () => {
    getMessage.mockResolvedValue(
      makeDetail({
        from: { email: ACCOUNT_EMAIL, name: "Me" },
        to: [],
      }),
    );

    await expect(
      service.replyMail("org-1", "user-1", 1, "msg-id-abc", "thread-123", "<p>Reply</p>", []),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(replyToThread).not.toHaveBeenCalled();
  });

  it("passes threadId correctly through the options object", async () => {
    getMessage.mockResolvedValue(makeDetail());

    await service.replyMail("org-1", "user-1", 1, "msg-id-abc", "thread-xyz", "<p>Hi</p>", []);

    const [, , opts] = replyToThread.mock.calls[0] as [unknown, unknown, { threadId: string }];
    expect(opts.threadId).toBe("thread-xyz");
  });

  it("throws BadRequestException when threadId is missing for Gmail", async () => {
    await expect(
      service.replyMail("org-1", "user-1", 1, "msg-id-abc", undefined, "<p>Reply</p>", []),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(getMessage).not.toHaveBeenCalled();
    expect(replyToThread).not.toHaveBeenCalled();
  });
});
