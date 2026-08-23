import { logger } from "../../../common/logger/logger.service";
import { ChatMessagesService } from "../chat-messages.service";
import { ChatMessageFanoutService } from "../chat-message-fanout.service";

const persisted = {
  id: 1,
  channelId: 1,
  senderId: "sender",
  content: "hello @alex",
  createdAt: new Date(),
  replyToId: null,
  metadata: null,
  messageType: "TEXT",
};

function makeDb() {
  const chain: Record<string, unknown> = {};
  for (const method of ["insert", "values", "update", "set", "where", "from", "select", "delete"])
    chain[method] = jest.fn(() => chain);
  chain.returning = jest.fn().mockResolvedValue([persisted]);
  chain.limit = jest.fn().mockResolvedValue([{ id: 1 }]);
  chain.query = {
    chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ userId: "sender" }) },
    chatChannels: { findFirst: jest.fn().mockResolvedValue({ type: "PUBLIC" }) },
  };
  chain.execute = jest.fn().mockResolvedValue([]);
  chain.transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(chain));
  return chain;
}

const flushDeferred = () => new Promise((resolve) => setImmediate(resolve));

function makeService(fanout: { dispatch: jest.Mock }) {
  const db = makeDb();
  return new ChatMessagesService(
    db as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    { configured: false, publishChatMessage: jest.fn() } as never,
    { configured: false, sendToChannelMembers: jest.fn() } as never,
    { publishNewMessageNotification: jest.fn(), publishMentionNotification: jest.fn() } as never,
    { scheduleForMessage: jest.fn().mockResolvedValue(undefined) } as never,
    { getSettings: jest.fn().mockResolvedValue({ maxAttachmentSizeMb: 10 }) } as never,
    { resolve: jest.fn().mockResolvedValue([]) } as never,
    fanout as never,
  );
}

describe("ChatMessagesService.send", () => {
  beforeEach(() => { jest.spyOn(logger, "error").mockImplementation(() => undefined); });

  it("dispatches exactly one fan-out for a message", async () => {
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const service = makeService({ dispatch });

    await service.send(1, "sender", "org-1", { content: "hello @alex" } as never);
    await flushDeferred();

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("returns the persisted message", async () => {
    const service = makeService({ dispatch: jest.fn().mockResolvedValue(undefined) });

    const result = await service.send(1, "sender", "org-1", { content: "hello" } as never);

    expect(result).toMatchObject({ id: 1, channelId: 1 });
  });

  it("still returns the message when the fan-out fails", async () => {
    const service = makeService({ dispatch: jest.fn().mockRejectedValue(new Error("ably down")) });

    const result = await service.send(1, "sender", "org-1", { content: "hello" } as never);
    await flushDeferred();

    expect(result).toMatchObject({ id: 1 });
  });
});

describe("ChatMessageFanoutService", () => {
  const message = { ...persisted };

  function makeFanout(overrides: Record<string, unknown> = {}) {
    const ably = { configured: true, publishChatMessage: jest.fn().mockResolvedValue(undefined) };
    const webPush = { configured: true, sendToChannelMembers: jest.fn().mockResolvedValue(undefined) };
    const notifications = {
      publishNewMessageNotification: jest.fn().mockResolvedValue(undefined),
      publishMentionNotification: jest.fn().mockResolvedValue(undefined),
    };
    const db = makeDb();
    db.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([{ name: "Sender", image: null }]) })),
      })),
    }));
    const service = new ChatMessageFanoutService(
      db as never,
      ably as never,
      webPush as never,
      notifications as never,
    );
    void overrides;
    return { service, ably, webPush, notifications };
  }

  const input = {
    orgId: "org-1",
    channelId: 1,
    message,
    body: { content: "hello" },
    attachments: [],
  };

  it("publishes the message to realtime", async () => {
    const { service, ably } = makeFanout();
    await service.dispatch(input as never);
    expect(ably.publishChatMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps notifying when push fails", async () => {
    const { service, webPush, notifications } = makeFanout();
    webPush.sendToChannelMembers.mockRejectedValue(new Error("push down"));

    await service.dispatch({ ...input, channelType: "DIRECT" } as never);

    expect(notifications.publishNewMessageNotification).toHaveBeenCalledTimes(1);
  });

  it("does not use the direct-message path for a channel message", async () => {
    const { service, notifications } = makeFanout();
    await service.dispatch({ ...input, channelType: "PUBLIC" } as never);
    expect(notifications.publishNewMessageNotification).not.toHaveBeenCalled();
  });
});
