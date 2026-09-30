import { OutboxConsumerRegistry, type OutboxEventRow } from "../../common/outbox/outbox-consumer.registry";
import { ChatFanoutOutboxConsumer } from "./chat-fanout-outbox.consumer";
import { CHAT_MESSAGE_FANOUT_EVENT } from "./chat-fanout-outbox";

function makeDb() {
  const latestLimit = jest.fn().mockResolvedValue([]);
  const selectWhere = jest.fn().mockReturnValue({
    limit: jest.fn().mockResolvedValue([]),
    orderBy: jest.fn().mockReturnValue({ limit: latestLimit }),
  });
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({ where: selectWhere }),
  });
  const update = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  });
  const insert = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
  });
  return { insert, select, update };
}

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "event-1",
    organizationId: "org-1",
    aggregateType: "chat.message",
    aggregateId: "1",
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "IN_FLIGHT",
    eventType: CHAT_MESSAGE_FANOUT_EVENT,
    payload: {
      orgId: "org-1",
      channelId: 1,
      channelType: "PUBLIC",
      message: {
        id: 1,
        channelId: 1,
        senderId: "sender-1",
        content: "hello",
        createdAt: new Date(),
        replyToId: null,
        metadata: null,
        messageType: "text",
      },
      content: "hello",
      mentionedUserIds: [],
      attachments: [],
      strippedMetadata: null,
      senderName: "Alice",
      senderImage: "https://cdn.example.com/alice.jpg",
    },
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("ChatFanoutOutboxConsumer", () => {
  it("registers and dispatches the persisted sender identity", async () => {
    const db = makeDb();
    const dispatchDeferred = jest.fn().mockResolvedValue(undefined);
    const dispatchRealtime = jest.fn().mockResolvedValue(undefined);
    const registry = new OutboxConsumerRegistry();
    const consumer = new ChatFanoutOutboxConsumer(db as never, { dispatchDeferred, dispatchRealtime } as never, registry);

    consumer.onModuleInit();
    await consumer.handle(makeEvent());

    expect(registry.get(CHAT_MESSAGE_FANOUT_EVENT)).toBe(consumer);
    expect(dispatchDeferred).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        senderName: "Alice",
        senderImage: "https://cdn.example.com/alice.jpg",
      }),
      {
        idempotencyKey: "outbox:event-1:chat-message:org-1:1",
        producerEventId: "event-1",
      },
    );
    expect(dispatchRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      {
        idempotencyKey: "outbox:event-1:chat-message:org-1:1",
        producerEventId: "event-1",
      },
    );
  });

  it("rejects a payload that tries to fan out in another tenant", async () => {
    const db = makeDb();
    const dispatchDeferred = jest.fn().mockResolvedValue(undefined);
    const consumer = new ChatFanoutOutboxConsumer(
      db as never,
      { dispatchDeferred, dispatchRealtime: jest.fn().mockResolvedValue(undefined) } as never,
      new OutboxConsumerRegistry(),
    );

    await expect(
      consumer.handle(makeEvent({
        payload: { ...(makeEvent().payload as Record<string, unknown>), orgId: "org-2" },
      })),
    ).resolves.toBeUndefined();
    expect(dispatchDeferred).not.toHaveBeenCalled();
  });

  it("propagates a side-effect failure so the outbox retries it", async () => {
    const db = makeDb();
    const consumer = new ChatFanoutOutboxConsumer(
      db as never,
      { dispatchDeferred: jest.fn().mockRejectedValue(new Error("provider down")), dispatchRealtime: jest.fn().mockResolvedValue(undefined) } as never,
      new OutboxConsumerRegistry(),
    );

    await expect(consumer.handle(makeEvent())).rejects.toThrow("provider down");
  });

  it("turns a malformed persisted payload into a durable failed inbox record", async () => {
    const db = makeDb();
    const consumer = new ChatFanoutOutboxConsumer(
      db as never,
      { dispatchDeferred: jest.fn(), dispatchRealtime: jest.fn() } as never,
      new OutboxConsumerRegistry(),
    );

    await expect(consumer.handle(makeEvent({ payload: { orgId: "org-1" } }))).resolves.toBeUndefined();

    expect(db.update).toHaveBeenCalled();
    expect(db.update.mock.results[0]?.value.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
  });

  it("still delivers push / DM / mentions and completes when the realtime backstop fails", async () => {
    const db = makeDb();
    const dispatchDeferred = jest.fn().mockResolvedValue(undefined);
    const consumer = new ChatFanoutOutboxConsumer(
      db as never,
      {
        dispatchRealtime: jest.fn().mockRejectedValue(new Error("Ably is not configured")),
        dispatchDeferred,
      } as never,
      new OutboxConsumerRegistry(),
    );

    await expect(consumer.handle(makeEvent())).resolves.toBeUndefined();
    expect(dispatchDeferred).toHaveBeenCalledTimes(1);
    expect(db.update.mock.results[0]?.value.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "COMPLETED" }),
    );
  });

  it("reuses the same idempotency key when a worker crashes before inbox completion", async () => {
    const db = makeDb();
    const dispatchDeferred = jest
      .fn()
      .mockRejectedValueOnce(new Error("worker crashed after provider call"))
      .mockResolvedValueOnce(undefined);
    const consumer = new ChatFanoutOutboxConsumer(
      db as never,
      { dispatchDeferred, dispatchRealtime: jest.fn().mockResolvedValue(undefined) } as never,
      new OutboxConsumerRegistry(),
    );

    await expect(consumer.handle(makeEvent())).rejects.toThrow("worker crashed");
    await expect(consumer.handle(makeEvent())).resolves.toBeUndefined();

    expect(dispatchDeferred).toHaveBeenCalledTimes(2);
    expect(dispatchDeferred.mock.calls[0]?.[1]).toEqual(dispatchDeferred.mock.calls[1]?.[1]);
    expect(dispatchDeferred.mock.calls[1]?.[1]).toEqual({
      idempotencyKey: "outbox:event-1:chat-message:org-1:1",
      producerEventId: "event-1",
    });
  });
});
