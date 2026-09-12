import { BadRequestException } from "@nestjs/common";
import { MailComposeService } from "./mail-compose.service";
import type { GmailMailProvider } from "./providers/gmail-mail.provider";
import type { OutlookMailProvider } from "./providers/outlook-mail.provider";
import type { MailAccountsService, MailAccount } from "./mail-accounts.service";
import type { CacheService } from "../../common/cache/cache.service";
import type { MailMetadataService } from "./mail-metadata.service";
import type { MailMessageDetail } from "./dto/mail-response.schemas";

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
  let service: MailComposeService;
  const assertOwnedConnection = jest.fn();
  const getMessage = jest.fn();
  const replyToThread = jest.fn();

  const gmail = { getMessage, replyToThread } as unknown as GmailMailProvider;
  const accounts = { assertOwnedConnection } as unknown as MailAccountsService;
  const outlook = {} as unknown as OutlookMailProvider;
  const cache = {} as unknown as CacheService;
  const metadata = {} as unknown as MailMetadataService;

  beforeEach(() => {
    jest.resetAllMocks();
    assertOwnedConnection.mockResolvedValue(mockAccount);
    replyToThread.mockResolvedValue(undefined);
    service = new MailComposeService(accounts, gmail, outlook, cache, metadata);
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

/**
 * The reply compose sheet has always rendered a To field: editable, prefilled,
 * and validated as required. Until this change the request body had no field to
 * carry it, so whatever the sender typed was dropped at the network boundary and
 * the server re-derived a recipient from the message being replied to. The
 * sender saw "Reply sent" for a message delivered to somebody they had just
 * removed from the field.
 *
 * The derivation is still right when the client sends no `to` — an older client,
 * or an integration posting the documented body. What must never happen again is
 * a `to` arriving and being ignored.
 */
describe("MailService.replyMail — an explicitly chosen recipient overrides the derivation", () => {
  let service: MailComposeService;
  const assertOwnedConnection = jest.fn();
  const getMessage = jest.fn();
  const replyToThread = jest.fn();
  const replyToMessage = jest.fn();

  const gmail = { getMessage, replyToThread } as unknown as GmailMailProvider;
  const accounts = { assertOwnedConnection } as unknown as MailAccountsService;
  const outlook = { replyToMessage } as unknown as OutlookMailProvider;
  const cache = {} as unknown as CacheService;
  const metadata = {} as unknown as MailMetadataService;

  beforeEach(() => {
    jest.resetAllMocks();
    assertOwnedConnection.mockResolvedValue(mockAccount);
    replyToThread.mockResolvedValue(undefined);
    replyToMessage.mockResolvedValue(undefined);
    getMessage.mockResolvedValue(
      makeDetail({ from: { email: "sender@example.com", name: "Sender" } }),
    );
    service = new MailComposeService(accounts, gmail, outlook, cache, metadata);
  });

  it("Gmail: sends to the address the caller chose, not to the original sender", async () => {
    await service.replyMail(
      "org-1", "user-1", 1, "msg-id-abc", "thread-123", "<p>Reply</p>", [],
      ["chosen@example.com"],
    );

    const [, , opts] = replyToThread.mock.calls[0] as [unknown, unknown, { recipientEmail: string }];
    expect(opts.recipientEmail).toBe("chosen@example.com");
    expect(opts.recipientEmail).not.toBe("sender@example.com");
  });

  it("Gmail: does not even fetch the original when the caller named the recipient", async () => {
    await service.replyMail(
      "org-1", "user-1", 1, "msg-id-abc", "thread-123", "<p>Reply</p>", [],
      ["chosen@example.com"],
    );

    expect(getMessage).not.toHaveBeenCalled();
  });

  it("Gmail: still derives the recipient when the caller sends no `to`", async () => {
    await service.replyMail("org-1", "user-1", 1, "msg-id-abc", "thread-123", "<p>Reply</p>", []);

    const [, , opts] = replyToThread.mock.calls[0] as [unknown, unknown, { recipientEmail: string }];
    expect(opts.recipientEmail).toBe("sender@example.com");
    expect(getMessage).toHaveBeenCalledTimes(1);
  });

  it("Outlook: hands the chosen address to the provider instead of dropping it", async () => {
    assertOwnedConnection.mockResolvedValue({ ...mockAccount, provider: "outlook" });

    await service.replyMail(
      "org-1", "user-1", 1, "msg-id-abc", "thread-123", "<p>Reply</p>", ["cc@example.com"],
      ["chosen@example.com"],
    );

    expect(replyToMessage).toHaveBeenCalledTimes(1);
    expect(replyToMessage.mock.calls[0]).toEqual([
      "user-1",
      expect.objectContaining({ provider: "outlook" }),
      "msg-id-abc",
      "<p>Reply</p>",
      ["cc@example.com"],
      "chosen@example.com",
    ]);
  });

  it("Outlook: passes undefined when the caller sends no `to`, so Graph addresses it as before", async () => {
    assertOwnedConnection.mockResolvedValue({ ...mockAccount, provider: "outlook" });

    await service.replyMail("org-1", "user-1", 1, "msg-id-abc", "thread-123", "<p>Reply</p>", []);

    expect(replyToMessage.mock.calls[0]?.[5]).toBeUndefined();
  });
});
