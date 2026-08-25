import { logger } from "../../../common/logger/logger.service";
import { ChatMessagesService } from "../chat-messages.service";
import { ChatMessageFanoutService, InProcessMessageFanout } from "../chat-message-fanout.service";
import { QueuedMessageFanout, InMemoryFanoutDeferralPort } from "../chat-message-fanout-queued.service";
import type { FanoutDeferredTask, FanoutInput } from "../message-fanout.interface";
import type { PersistedMessage } from "../chat-message.types";

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
        { userId: "sender" },
        { userId: "user-alex" },
        { userId: "user-alexander" },
      ]),
    },
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

  it("hands the composer's mention identities to the fan-out, checked against the roster", async () => {
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const service = makeService({ dispatch });

    await service.send(1, "sender", "org-1", {
      content: "hello @alex",
      mentionedUserIds: ["user-alex"],
    } as never);
    await flushDeferred();

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ mentionedUserIds: ["user-alex"] }),
    );
  });

  it("expands @everyone to the channel, which the send path previously never did", async () => {
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const service = makeService({ dispatch });

    await service.send(1, "sender", "org-1", { content: "@everyone standup" } as never);
    await flushDeferred();

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ mentionedUserIds: ["user-alex", "user-alexander"] }),
    );
  });

  it("drops a claimed mention for someone who is not in the channel", async () => {
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const service = makeService({ dispatch });

    await service.send(1, "sender", "org-1", {
      content: "hello @outsider",
      mentionedUserIds: ["user-outsider"],
    } as never);
    await flushDeferred();

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ mentionedUserIds: [] }));
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
  const message: PersistedMessage = { ...persisted };

  function makeFanout() {
    const ably = { configured: true, publishChatMessage: jest.fn().mockResolvedValue(undefined) };
    const webPush = { configured: true, sendToChannelMembers: jest.fn().mockResolvedValue(undefined) };
    const notifications = {
      publishNewMessageNotification: jest.fn().mockResolvedValue(undefined),
      publishMentionNotification: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { log: jest.fn() };
    const service = new InProcessMessageFanout(
      ably as never,
      webPush as never,
      notifications as never,
      audit as never,
    );
    return { service, ably, webPush, notifications, audit };
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

  it("keeps notifying when push fails", async () => {
    const { service, webPush, notifications } = makeFanout();
    jest.spyOn(logger, "error").mockImplementation(() => undefined);
    webPush.sendToChannelMembers.mockRejectedValue(new Error("push down"));

    await service.dispatch({ ...input, channelType: "DIRECT" } as never);

    expect(notifications.publishNewMessageNotification).toHaveBeenCalledTimes(1);
  });

  it("does not use the direct-message path for a channel message", async () => {
    const { service, notifications } = makeFanout();
    await service.dispatch({ ...input, channelType: "PUBLIC" } as never);
    expect(notifications.publishNewMessageNotification).not.toHaveBeenCalled();
  });

  it("records exactly one failure when the middle side effect rejects, completes the other two, and resolves dispatch", async () => {
    jest.spyOn(logger, "error").mockImplementation(() => undefined);

    const { service, webPush, notifications, audit } = makeFanout();
    webPush.sendToChannelMembers.mockResolvedValue(undefined);
    notifications.publishNewMessageNotification.mockRejectedValue(new Error("dm down"));
    notifications.publishMentionNotification.mockResolvedValue(undefined);

    await service.dispatch({
      ...input,
      channelType: "DIRECT",
      mentionedUserIds: ["user-1"],
    } as never);

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

describe("parity: InProcessMessageFanout and QueuedMessageFanout address the same recipients", () => {
  beforeEach(() => { jest.spyOn(logger, "error").mockImplementation(() => undefined); });

  const message: PersistedMessage = { ...persisted };

  function makeCollaborators() {
    return {
      ably: { configured: true, publishChatMessage: jest.fn().mockResolvedValue(undefined) },
      webPush: { configured: true, sendToChannelMembers: jest.fn().mockResolvedValue(undefined) },
      notifications: {
        publishNewMessageNotification: jest.fn().mockResolvedValue(undefined),
        publishMentionNotification: jest.fn().mockResolvedValue(undefined),
      },
      audit: { log: jest.fn() },
    };
  }

  function makeInProcess(c: ReturnType<typeof makeCollaborators>): ChatMessageFanoutService {
    return new InProcessMessageFanout(
      c.ably as never,
      c.webPush as never,
      c.notifications as never,
      c.audit as never,
    );
  }

  function makeQueued(c: ReturnType<typeof makeCollaborators>): ChatMessageFanoutService {
    const db = makeDb();
    const port = new InMemoryFanoutDeferralPort();
    return new QueuedMessageFanout(
      db as never,
      port,
      c.ably as never,
      c.webPush as never,
      c.notifications as never,
      c.audit as never,
    );
  }

  it("both publish realtime and push for a public channel message", async () => {
    const input: FanoutInput = {
      orgId: "org-p",
      channelId: 2,
      channelType: "PUBLIC",
      message,
      content: "hello",
      mentionedUserIds: undefined,
      attachments: [],
      strippedMetadata: null,
      senderName: "Bob",
      senderImage: null,
    };

    const inProcessC = makeCollaborators();
    const queuedC = makeCollaborators();

    await makeInProcess(inProcessC).dispatch(input);
    await makeQueued(queuedC).dispatch(input);
    await flushDeferred();

    expect(inProcessC.ably.publishChatMessage).toHaveBeenCalledTimes(1);
    expect(queuedC.ably.publishChatMessage).toHaveBeenCalledTimes(1);

    expect(inProcessC.webPush.sendToChannelMembers).toHaveBeenCalledTimes(1);
    expect(queuedC.webPush.sendToChannelMembers).toHaveBeenCalledTimes(1);

    expect(inProcessC.notifications.publishNewMessageNotification).not.toHaveBeenCalled();
    expect(queuedC.notifications.publishNewMessageNotification).not.toHaveBeenCalled();

    expect(inProcessC.notifications.publishMentionNotification).not.toHaveBeenCalled();
    expect(queuedC.notifications.publishMentionNotification).not.toHaveBeenCalled();
  });

  it("both send DM notification for a DIRECT channel message", async () => {
    const input: FanoutInput = {
      orgId: "org-p",
      channelId: 3,
      channelType: "DIRECT",
      message,
      content: "hey",
      mentionedUserIds: undefined,
      attachments: [],
      strippedMetadata: null,
      senderName: "Carol",
      senderImage: null,
    };

    const inProcessC = makeCollaborators();
    const queuedC = makeCollaborators();

    await makeInProcess(inProcessC).dispatch(input);
    await makeQueued(queuedC).dispatch(input);
    await flushDeferred();

    expect(inProcessC.notifications.publishNewMessageNotification).toHaveBeenCalledTimes(1);
    expect(queuedC.notifications.publishNewMessageNotification).toHaveBeenCalledTimes(1);

    const [inArgs] = inProcessC.notifications.publishNewMessageNotification.mock.calls as [unknown[]];
    const [qArgs] = queuedC.notifications.publishNewMessageNotification.mock.calls as [unknown[]];
    expect(inArgs).toEqual(qArgs);
  });

  it("both send mention notification only to the listed recipients", async () => {
    const input: FanoutInput = {
      orgId: "org-p",
      channelId: 4,
      channelType: "PUBLIC",
      message,
      content: "hello @user-1",
      mentionedUserIds: ["user-1"],
      attachments: [],
      strippedMetadata: null,
      senderName: "Dave",
      senderImage: null,
    };

    const inProcessC = makeCollaborators();
    const queuedC = makeCollaborators();

    await makeInProcess(inProcessC).dispatch(input);
    await makeQueued(queuedC).dispatch(input);
    await flushDeferred();

    expect(inProcessC.notifications.publishMentionNotification).toHaveBeenCalledTimes(1);
    expect(queuedC.notifications.publishMentionNotification).toHaveBeenCalledTimes(1);

    const [inArgs] = inProcessC.notifications.publishMentionNotification.mock.calls as [unknown[]];
    const [qArgs] = queuedC.notifications.publishMentionNotification.mock.calls as [unknown[]];
    expect(inArgs).toEqual(qArgs);
  });

  it("both skip mention notification when mentionedUserIds is empty", async () => {
    const input: FanoutInput = {
      orgId: "org-p",
      channelId: 5,
      channelType: "PUBLIC",
      message,
      content: "no mentions",
      mentionedUserIds: [],
      attachments: [],
      strippedMetadata: null,
      senderName: "Eve",
      senderImage: null,
    };

    const inProcessC = makeCollaborators();
    const queuedC = makeCollaborators();

    await makeInProcess(inProcessC).dispatch(input);
    await makeQueued(queuedC).dispatch(input);
    await flushDeferred();

    expect(inProcessC.notifications.publishMentionNotification).not.toHaveBeenCalled();
    expect(queuedC.notifications.publishMentionNotification).not.toHaveBeenCalled();
  });

  it("queued: each deferred task opens its own tenant context, not the dispatch caller's", async () => {
    const input: FanoutInput = {
      orgId: "org-p",
      channelId: 6,
      channelType: "PUBLIC",
      message,
      content: "hello",
      mentionedUserIds: undefined,
      attachments: [],
      strippedMetadata: null,
      senderName: "Frank",
      senderImage: null,
    };

    const db = makeDb();
    const port = new InMemoryFanoutDeferralPort();
    const c = makeCollaborators();
    const queued = new QueuedMessageFanout(
      db as never,
      port,
      c.ably as never,
      c.webPush as never,
      c.notifications as never,
      c.audit as never,
    );

    await queued.dispatch(input);
    await flushDeferred();

    expect(db.transaction as jest.Mock).toHaveBeenCalledTimes(1);
    expect(c.webPush.sendToChannelMembers).toHaveBeenCalledTimes(1);
  });

  it("queued: a failing deferred task is recorded but does not prevent other tasks from running", async () => {
    const input: FanoutInput = {
      orgId: "org-p",
      channelId: 7,
      channelType: "DIRECT",
      message,
      content: "hello",
      mentionedUserIds: ["user-1"],
      attachments: [],
      strippedMetadata: null,
      senderName: "Grace",
      senderImage: null,
    };

    const db = makeDb();
    const port = new InMemoryFanoutDeferralPort();
    const c = makeCollaborators();
    c.webPush.sendToChannelMembers.mockRejectedValue(new Error("push down"));

    const queued = new QueuedMessageFanout(
      db as never,
      port,
      c.ably as never,
      c.webPush as never,
      c.notifications as never,
      c.audit as never,
    );

    await queued.dispatch(input);
    await flushDeferred();
    await flushDeferred();

    expect(c.ably.publishChatMessage).toHaveBeenCalledTimes(1);
    expect(c.notifications.publishNewMessageNotification).toHaveBeenCalledTimes(1);
    expect(c.notifications.publishMentionNotification).toHaveBeenCalledTimes(1);
    expect(c.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "chat:fanout:failure",
        metadata: expect.objectContaining({ channel: "push" }),
      }),
    );
  });
});

describe("FanoutDeferralPort contract: InMemoryFanoutDeferralPort", () => {
  it("runs deferred tasks after the current call stack via setImmediate", async () => {
    const order: string[] = [];
    const port = new InMemoryFanoutDeferralPort();

    const task: FanoutDeferredTask = {
      orgId: "org-1",
      run: async () => { order.push("task"); },
    };

    port.defer(task);
    order.push("after-defer");
    await flushDeferred();

    expect(order).toEqual(["after-defer", "task"]);
  });
});
