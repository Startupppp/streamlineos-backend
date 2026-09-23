import { Test, type TestingModule } from "@nestjs/testing";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

const DISPATCH_RESULT = {
  eventKey: "chat.message.mention",
  notified: 1,
  deliveriesQueued: 0,
  suppressed: 0,
  deduped: 0,
  deferred: false,
  failedRecipients: 0,
};

function makeDb() {
  const chain = {} as Record<string, jest.Mock>;
  for (const method of ["from", "innerJoin", "where"])
    chain[method] = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.limit = jest.fn().mockResolvedValue([]);
  return chain;
}

function buildModule(db: ReturnType<typeof makeDb>, overrides?: { orgSettings?: object; dispatch?: object }) {
  const mockAbly = { publishToUser: jest.fn().mockResolvedValue(undefined) };
  const mockOrgSettings = overrides?.orgSettings ?? {
    getSettings: jest.fn().mockResolvedValue({ defaultNotificationPreference: "ALL" }),
  };
  const mockEffects = {
    execute: jest.fn().mockResolvedValue("EXECUTED"),
    executeBatch: jest.fn().mockResolvedValue(undefined),
  };
  const mockDispatch = overrides?.dispatch ?? { emitNow: jest.fn().mockResolvedValue(DISPATCH_RESULT) };

  return { mockAbly, mockOrgSettings, mockEffects, mockDispatch,
    module: Test.createTestingModule({
      providers: [
        ChatNotificationsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AblyService, useValue: mockAbly },
        { provide: ChatOrgSettingsService, useValue: mockOrgSettings },
        { provide: ExternalEffectLedger, useValue: mockEffects },
        { provide: NotificationDispatchService, useValue: mockDispatch },
      ],
    }).compile() };
}

const baseMessage = { id: 42, senderUserId: "sender-1", senderName: "Sam" };

describe("ChatNotificationsService — inbox dispatch for mentions", () => {
  let service: ChatNotificationsService;
  let mockDispatch: { emitNow: jest.Mock };
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    db = makeDb();
    const built = buildModule(db);
    mockDispatch = built.mockDispatch as { emitNow: jest.Mock };
    const mod: TestingModule = await built.module;
    service = mod.get(ChatNotificationsService);
  });

  it("emits chat.message.mention to the inbox for a mentioned user", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", notificationPreference: "ALL" }]);
    await service.publishMentionNotification("org-1", 7, baseMessage, ["user-b"]);
    expect(mockDispatch.emitNow).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "chat.message.mention",
        orgId: "org-1",
        targetUserIds: ["user-b"],
        channels: ["IN_APP"],
        entityType: "chat_message",
        entityId: "42",
        link: "/chat?channel=7&message=42",
      }),
    );
  });

  it("never emits an inbox notification for the sender themselves", async () => {
    db.where.mockResolvedValueOnce([{ userId: "sender-1", notificationPreference: "ALL" }]);
    await service.publishMentionNotification("org-1", 7, baseMessage, ["sender-1"]);
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("skips inbox for a user with preference NOTHING", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", notificationPreference: "NOTHING" }]);
    await service.publishMentionNotification("org-1", 7, baseMessage, ["user-b"]);
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("passes the idempotency key as replayKey to prevent duplicate inbox rows on fanout retry", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", notificationPreference: "ALL" }]);
    await service.publishMentionNotification("org-1", 7, baseMessage, ["user-b"], "fanout-key-1:mention_notification");
    expect(mockDispatch.emitNow).toHaveBeenCalledWith(
      expect.objectContaining({ replayKey: "fanout-key-1:mention_notification:inbox" }),
    );
  });

  it("does nothing at all when the mention list is empty", async () => {
    await service.publishMentionNotification("org-1", 7, baseMessage, []);
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("restricts inbox dispatch to IN_APP only — no PUSH or EMAIL queued by the dispatch pipeline", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", notificationPreference: "ALL" }]);
    await service.publishMentionNotification("org-1", 7, baseMessage, ["user-b"]);
    const call = mockDispatch.emitNow.mock.calls[0]?.[0] as { channels?: string[] } | undefined;
    expect(call?.channels).toEqual(["IN_APP"]);
  });
});

describe("ChatNotificationsService — inbox dispatch for direct messages", () => {
  let service: ChatNotificationsService;
  let mockDispatch: { emitNow: jest.Mock };
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    db = makeDb();
    const built = buildModule(db);
    mockDispatch = built.mockDispatch as { emitNow: jest.Mock };
    const mod: TestingModule = await built.module;
    service = mod.get(ChatNotificationsService);
  });

  it("emits chat.message.direct to inbox when channel type is DIRECT", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", mutedUntil: null, notificationPreference: "ALL" }]);
    await service.publishNewMessageNotification("org-1", 5, baseMessage, "DIRECT");
    expect(mockDispatch.emitNow).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "chat.message.direct",
        orgId: "org-1",
        targetUserIds: ["user-b"],
        channels: ["IN_APP"],
        link: "/chat?channel=5",
      }),
    );
  });

  it("does NOT emit to inbox for GROUP channel type", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", mutedUntil: null, notificationPreference: "ALL" }]);
    await service.publishNewMessageNotification("org-1", 5, baseMessage, "GROUP");
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("skips inbox for the sender in a DM channel", async () => {
    db.where.mockResolvedValueOnce([{ userId: "sender-1", mutedUntil: null, notificationPreference: "ALL" }]);
    await service.publishNewMessageNotification("org-1", 5, baseMessage, "DIRECT");
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("skips inbox for a muted DM channel recipient", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", mutedUntil: new Date(Date.now() + 3_600_000), notificationPreference: "ALL" }]);
    await service.publishNewMessageNotification("org-1", 5, baseMessage, "DIRECT");
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("skips inbox for a DM recipient whose preference is NOTHING", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", mutedUntil: null, notificationPreference: "NOTHING" }]);
    await service.publishNewMessageNotification("org-1", 5, baseMessage, "DIRECT");
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("skips inbox for a DM recipient whose preference is MENTIONS (MENTIONS suppresses DMs)", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", mutedUntil: null, notificationPreference: "MENTIONS" }]);
    await service.publishNewMessageNotification("org-1", 5, baseMessage, "DIRECT");
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("passes idempotency replayKey for a DM inbox notification", async () => {
    db.where.mockResolvedValueOnce([{ userId: "user-b", mutedUntil: null, notificationPreference: "ALL" }]);
    await service.publishNewMessageNotification("org-1", 5, baseMessage, "DIRECT", "dm-key-1:dm_notification");
    expect(mockDispatch.emitNow).toHaveBeenCalledWith(
      expect.objectContaining({ replayKey: "dm-key-1:dm_notification:inbox" }),
    );
  });
});

describe("ChatNotificationsService — inbox dispatch for thread replies", () => {
  let service: ChatNotificationsService;
  let mockDispatch: { emitNow: jest.Mock };
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    db = makeDb();
    const built = buildModule(db);
    mockDispatch = built.mockDispatch as { emitNow: jest.Mock };
    const mod: TestingModule = await built.module;
    service = mod.get(ChatNotificationsService);
  });

  it("notifies the parent message author when someone replies to their message", async () => {
    db.limit.mockResolvedValueOnce([{ userId: "author-1", notificationPreference: "ALL", mutedUntil: null }]);
    await service.publishThreadReplyInboxNotification("org-1", 7, { id: 99, replyToId: 55, senderUserId: "sender-1" });
    expect(mockDispatch.emitNow).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "chat.thread.reply",
        orgId: "org-1",
        targetUserIds: ["author-1"],
        channels: ["IN_APP"],
        entityType: "chat_message",
        entityId: "99",
        link: "/chat?channel=7&message=55",
      }),
    );
  });

  it("does not notify when the sender replies to their own message", async () => {
    db.limit.mockResolvedValueOnce([{ userId: "sender-1", notificationPreference: "ALL", mutedUntil: null }]);
    await service.publishThreadReplyInboxNotification("org-1", 7, { id: 99, replyToId: 55, senderUserId: "sender-1" });
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("does not notify when the parent author has muted the channel", async () => {
    db.limit.mockResolvedValueOnce([{ userId: "author-1", notificationPreference: "ALL", mutedUntil: new Date(Date.now() + 3_600_000) }]);
    await service.publishThreadReplyInboxNotification("org-1", 7, { id: 99, replyToId: 55, senderUserId: "sender-1" });
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("does not notify when the parent author has preference NOTHING", async () => {
    db.limit.mockResolvedValueOnce([{ userId: "author-1", notificationPreference: "NOTHING", mutedUntil: null }]);
    await service.publishThreadReplyInboxNotification("org-1", 7, { id: 99, replyToId: 55, senderUserId: "sender-1" });
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("does nothing when the parent message has no known author (deleted membership)", async () => {
    db.limit.mockResolvedValueOnce([]);
    await service.publishThreadReplyInboxNotification("org-1", 7, { id: 99, replyToId: 55, senderUserId: "sender-1" });
    expect(mockDispatch.emitNow).not.toHaveBeenCalled();
  });

  it("passes idempotency replayKey for thread reply inbox", async () => {
    db.limit.mockResolvedValueOnce([{ userId: "author-1", notificationPreference: "ALL", mutedUntil: null }]);
    await service.publishThreadReplyInboxNotification("org-1", 7, { id: 99, replyToId: 55, senderUserId: "sender-1" }, "fanout-key-1:thread_reply_inbox");
    expect(mockDispatch.emitNow).toHaveBeenCalledWith(
      expect.objectContaining({ replayKey: "fanout-key-1:thread_reply_inbox:inbox" }),
    );
  });

  it("restricts thread reply to IN_APP channel only", async () => {
    db.limit.mockResolvedValueOnce([{ userId: "author-1", notificationPreference: "ALL", mutedUntil: null }]);
    await service.publishThreadReplyInboxNotification("org-1", 7, { id: 99, replyToId: 55, senderUserId: "sender-1" });
    const call = mockDispatch.emitNow.mock.calls[0]?.[0] as { channels?: string[] } | undefined;
    expect(call?.channels).toEqual(["IN_APP"]);
  });
});
