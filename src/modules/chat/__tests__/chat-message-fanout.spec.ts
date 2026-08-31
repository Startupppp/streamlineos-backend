import { logger } from "../../../common/logger/logger.service";
import { ChatMessagesService } from "../chat-messages.service";
import { ChatMessageFanoutService } from "../chat-message-fanout.service";
import type { PersistedMessage } from "../chat-message.types";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

const persisted: PersistedMessage = {
  id: 1,
  channelId: 1,
  senderId: "sender",
  content: "hello @alex",
  createdAt: new Date(),
  replyToId: null,
  metadata: null,
  messageType: "text",
};

function makeDb() {
  const chain: Record<string, unknown> = {};
  for (const method of ["insert", "values", "update", "set", "where", "from", "select", "delete"])
    chain[method] = jest.fn(() => chain);
  chain.returning = jest.fn().mockResolvedValue([persisted]);
  chain.limit = jest.fn().mockResolvedValue([{ id: 1 }]);
  chain.query = {
    chatChannelMembers: {
      findFirst: jest.fn().mockResolvedValue({ userId: "sender" }),
      findMany: jest.fn().mockResolvedValue([
        { membershipId: 1, membership: { userId: "sender" } },
        { membershipId: 2, membership: { userId: "user-alex" } },
        { membershipId: 3, membership: { userId: "user-alexander" } },
      ]),
    },
    chatChannels: { findFirst: jest.fn().mockResolvedValue({ type: "PUBLIC" }) },
    organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  chain.execute = jest.fn().mockResolvedValue([]);
  chain.transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(chain));
  return chain;
}

const flushDeferred = () => new Promise((resolve) => setImmediate(resolve));

function makeService() {
  const db = makeDb();
  const fanout = { dispatchRealtime: jest.fn().mockResolvedValue(undefined), dispatchDeferred: jest.fn() };
  return { service: new ChatMessagesService(
    db as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    { configured: false, publishChatMessage: jest.fn() } as never,
    { scheduleForMessage: jest.fn().mockResolvedValue(undefined) } as never,
    { getSettings: jest.fn().mockResolvedValue({ maxAttachmentSizeMb: 10 }) } as never,
    { resolve: jest.fn().mockResolvedValue([]) } as never,
    fanout as never,
  ), db, fanout };
}

function queuedFanout(db: Record<string, unknown>) {
  const values = db.values as jest.Mock;
  return values.mock.calls.map(([value]) => value as { eventType?: string; payload?: Record<string, unknown> })
    .find((value) => value.eventType === "chat.message.fanout");
}

describe("ChatMessagesService.send", () => {
  beforeEach(() => { jest.spyOn(logger, "error").mockImplementation(() => undefined); });

  it("dispatches exactly one fan-out for a message", async () => {
    const { service, db } = makeService();

    await service.send(1, "sender", "org-1", { content: "hello @alex" } as never);
    await flushDeferred();

    expect(queuedFanout(db)).toBeDefined();
  });

  it("hands the composer's mention identities to the fan-out, checked against the roster", async () => {
    const { service, db } = makeService();

    await service.send(1, "sender", "org-1", {
      content: "hello @alex",
      mentionedUserIds: ["user-alex"],
    } as never);
    await flushDeferred();

    expect(queuedFanout(db)?.payload).toEqual(expect.objectContaining({ mentionedUserIds: ["user-alex"] }));
  });

  it("persists sender identity in the outbox payload while the send transaction is open", async () => {
    const { service, db } = makeService();
    (db.limit as jest.Mock)
      .mockResolvedValueOnce([{ id: 1, type: "PUBLIC" }])
      .mockResolvedValueOnce([{ name: "Alice", image: "https://cdn.example.com/alice.jpg" }]);

    await service.send(1, "sender", "org-1", { content: "hello" } as never);

    expect(queuedFanout(db)?.payload).toEqual(
      expect.objectContaining({
        senderName: "Alice",
        senderImage: "https://cdn.example.com/alice.jpg",
      }),
    );
  });

  it("expands @everyone to the channel, which the send path previously never did", async () => {
    const { service, db } = makeService();

    await service.send(1, "sender", "org-1", { content: "@everyone standup" } as never);
    await flushDeferred();

    expect(queuedFanout(db)?.payload).toEqual(expect.objectContaining({ mentionedUserIds: ["user-alex", "user-alexander"] }));
  });

  it("drops a claimed mention for someone who is not in the channel", async () => {
    const { service, db } = makeService();

    await service.send(1, "sender", "org-1", {
      content: "hello @outsider",
      mentionedUserIds: ["user-outsider"],
    } as never);
    await flushDeferred();

    expect(queuedFanout(db)?.payload).toEqual(expect.objectContaining({ mentionedUserIds: [] }));
  });

  it("returns the persisted message", async () => {
    const { service } = makeService();

    const result = await service.send(1, "sender", "org-1", { content: "hello" } as never);

    expect(result).toMatchObject({ id: 1, channelId: 1 });
  });

  it("returns the message after the fan-out is durably enqueued", async () => {
    const { service } = makeService();

    const result = await service.send(1, "sender", "org-1", { content: "hello" } as never);
    await flushDeferred();

    expect(result).toMatchObject({ id: 1 });
  });
});

describe("ChatMessageFanoutService", () => {
  const message: PersistedMessage = { ...persisted };

  function makeFanout() {
    const db = { transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})) };
    const ably = { configured: true, publishChatMessage: jest.fn().mockResolvedValue(undefined) };
    const webPush = { configured: true, sendToChannelMembers: jest.fn().mockResolvedValue(undefined) };
    const notifications = {
      publishNewMessageNotification: jest.fn().mockResolvedValue(undefined),
      publishMentionNotification: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { log: jest.fn() };
    const effects = { execute: jest.fn(async (_effect: unknown, send: () => Promise<void>) => { await send(); return "EXECUTED"; }) };
    const service = new ChatMessageFanoutService(
      db as never,
      ably as never,
      webPush as never,
      notifications as never,
      audit as never,
      effects as never,
    );
    return { service, ably, webPush, notifications, audit, effects };
  }

  const input = {
    orgId: "org-1",
    channelId: 1,
    message,
    body: { content: "hello" },
    attachments: [],
    senderName: "Sender",
    senderImage: null,
  };

  it("publishes the message to realtime", async () => {
    const { service, ably } = makeFanout();
    await service.dispatch(input as never);
    expect(ably.publishChatMessage).toHaveBeenCalledTimes(1);
  });

  it("forwards the caller-supplied sender identity to the realtime payload without a database query", async () => {
    const { service, ably } = makeFanout();
    await service.dispatch({
      ...input,
      channelType: "PUBLIC",
      senderName: "Alice",
      senderImage: "https://cdn.example.com/alice.jpg",
    } as never);
    const [[, , payload]] = ably.publishChatMessage.mock.calls as [[unknown, unknown, { senderName: unknown; senderImage: unknown }]];
    expect(payload).toMatchObject({ senderName: "Alice", senderImage: "https://cdn.example.com/alice.jpg" });
  });

  it("uses a deterministic effect key for every deferred adapter on replay", async () => {
    const { service, webPush, notifications } = makeFanout();
    await service.dispatchDeferred({ ...input, channelType: "DIRECT" } as never);

    expect(webPush.sendToChannelMembers).toHaveBeenCalledWith(
      "org-1",
      1,
      "sender",
      { category: "CHAT" },
      "chat-message:org-1:1:push",
    );
    expect(notifications.publishNewMessageNotification).toHaveBeenCalledWith(
      "org-1",
      1,
      { id: 1, senderId: "sender", senderName: "Sender" },
      "DIRECT",
      "chat-message:org-1:1:dm_notification",
    );
  });

  it("keeps notifying when push fails", async () => {
    const { service, webPush, notifications } = makeFanout();
    jest.spyOn(logger, "error").mockImplementation(() => undefined);
    webPush.sendToChannelMembers.mockRejectedValue(new Error("push down"));

    await expect(service.dispatch({ ...input, channelType: "DIRECT" } as never)).rejects.toThrow("chat fan-out failed");

    expect(notifications.publishNewMessageNotification).toHaveBeenCalledTimes(1);
  });

  it("does not use the direct-message path for a channel message", async () => {
    const { service, notifications } = makeFanout();
    await service.dispatch({ ...input, channelType: "PUBLIC" } as never);
    expect(notifications.publishNewMessageNotification).not.toHaveBeenCalled();
  });

  it("records exactly one failure and rejects so the outbox retries the fan-out", async () => {
    jest.spyOn(logger, "error").mockImplementation(() => undefined);

    const { service, webPush, notifications, audit } = makeFanout();
    webPush.sendToChannelMembers.mockResolvedValue(undefined);
    notifications.publishNewMessageNotification.mockRejectedValue(new Error("dm down"));
    notifications.publishMentionNotification.mockResolvedValue(undefined);

    await expect(service.dispatch({
      ...input,
      channelType: "DIRECT",
      mentionedUserIds: ["user-1"],
    } as never)).rejects.toThrow("chat fan-out failed");

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "chat:fanout:failure",
        result: "FAILURE",
        metadata: expect.objectContaining({ channel: "dm_notification" }),
      }),
    );
    expect(webPush.sendToChannelMembers).toHaveBeenCalledTimes(1);
    expect(notifications.publishMentionNotification).toHaveBeenCalledTimes(1);
  });
});
