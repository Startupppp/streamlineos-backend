import type { MailMetadataService } from "./mail-metadata.service";
import type { MailMessageSummary } from "./dto/mail-schemas";

const ALICE = "user-alice";
const BOB = "user-bob";
const ORG = "org-1";
const ACCOUNT_ID = 42;

function makeMessage(id: string): MailMessageSummary {
  return {
    id,
    threadId: null,
    accountId: ACCOUNT_ID,
    provider: "gmail",
    from: { email: "sender@example.com", name: "Sender" },
    to: [],
    subject: `Subject ${id}`,
    snippet: "",
    date: new Date().toISOString(),
    isRead: false,
    isStarred: false,
    hasAttachments: false,
  };
}

describe("MailMetadataService — per-user isolation", () => {
  let service: MailMetadataService;

  const upsertBatch = jest.fn().mockResolvedValue(undefined);
  const listCached = jest.fn();
  const updateState = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    service = {
      upsertBatch,
      listCached,
      updateState,
    } as unknown as MailMetadataService;
    jest.clearAllMocks();
  });

  it("listCached is always called with the requesting user's userId", async () => {
    listCached.mockResolvedValue({ messages: [], hasData: false, isFresh: false });
    await service.listCached(ALICE, ORG, ACCOUNT_ID, "inbox", 25);
    expect(listCached).toHaveBeenCalledWith(ALICE, ORG, ACCOUNT_ID, "inbox", 25);
  });

  it("upsertBatch tags messages with the owner's userId, not the recipient's", async () => {
    const messages = [makeMessage("msg-1"), makeMessage("msg-2")];
    await service.upsertBatch(ACCOUNT_ID, BOB, ORG, "inbox", messages);
    expect(upsertBatch).toHaveBeenCalledWith(ACCOUNT_ID, BOB, ORG, "inbox", messages);
    const [, calledUserId] = upsertBatch.mock.calls[0] as [number, string, string, string, MailMessageSummary[]];
    expect(calledUserId).toBe(BOB);
    expect(calledUserId).not.toBe(ALICE);
  });

  it("updateState includes userId so cross-user writes are rejected", async () => {
    await service.updateState(ACCOUNT_ID, ALICE, ORG, "msg-1", { isRead: true });
    expect(updateState).toHaveBeenCalledWith(ACCOUNT_ID, ALICE, ORG, "msg-1", { isRead: true });
    const [, calledUserId] = updateState.mock.calls[0] as [number, string, string, string, object];
    expect(calledUserId).toBe(ALICE);
  });

  it("Alice's data is never included when Bob's inbox is listed", async () => {
    listCached.mockImplementation(async (userId: string) => {
      if (userId === BOB) {
        return {
          messages: [{ messageId: "bob-msg", folder: "inbox", isRead: false, isStarred: false, hasAttachment: false, labels: null, accountId: ACCOUNT_ID, senderEmail: "s@x.com", senderName: null, subject: "For Bob", date: new Date().toISOString(), threadId: null }],
          hasData: true,
          isFresh: true,
        };
      }
      return { messages: [], hasData: false, isFresh: false };
    });

    const aliceResult = await service.listCached(ALICE, ORG, ACCOUNT_ID, "inbox", 25);
    const bobResult = await service.listCached(BOB, ORG, ACCOUNT_ID, "inbox", 25);

    expect(aliceResult.messages).toHaveLength(0);
    expect(bobResult.messages).toHaveLength(1);
    expect(bobResult.messages[0]?.messageId).toBe("bob-msg");
  });
});
