import { OutboxBackedMessageFanoutProvider } from "./outbox-backed-message-fanout.provider";
import type { FanoutDeliveryContext, FanoutInput } from "./message-fanout.interface";

const input = {
  orgId: "org-1",
  channelId: 7,
  channelType: "PUBLIC",
  message: {
    id: 42,
    channelId: 7,
    senderId: "user-1",
    content: "hello",
    createdAt: new Date("2026-08-26T00:00:00.000Z"),
    replyToId: null,
    metadata: null,
    messageType: "text",
  },
  content: "hello",
  mentionedUserIds: [],
  attachments: [],
  strippedMetadata: null,
  senderName: "Alice",
  senderImage: null,
} as unknown as FanoutInput;

const context: FanoutDeliveryContext = {
  producerEventId: "event-42",
  idempotencyKey: "outbox:event-42:chat-message:org-1:42",
};

describe("OutboxBackedMessageFanoutProvider", () => {
  it("keeps realtime and deferred delivery as separate provider operations", async () => {
    const delivery = {
      dispatchRealtime: jest.fn().mockResolvedValue(undefined),
      dispatchDeferred: jest.fn().mockResolvedValue(undefined),
    };
    const provider = new OutboxBackedMessageFanoutProvider(delivery as never);

    await provider.dispatchRealtime(input, context);
    await provider.dispatchDeferred(input, context);

    expect(delivery.dispatchRealtime).toHaveBeenCalledTimes(1);
    expect(delivery.dispatchRealtime).toHaveBeenCalledWith(input, context);
    expect(delivery.dispatchDeferred).toHaveBeenCalledTimes(1);
    expect(delivery.dispatchDeferred).toHaveBeenCalledWith(input, context);
  });

  it("preserves the same idempotency context on a deferred replay", async () => {
    const delivery = {
      dispatchRealtime: jest.fn().mockResolvedValue(undefined),
      dispatchDeferred: jest.fn().mockResolvedValue(undefined),
    };
    const provider = new OutboxBackedMessageFanoutProvider(delivery as never);

    await provider.dispatchDeferred(input, context);
    await provider.dispatchDeferred(input, context);

    expect(delivery.dispatchDeferred.mock.calls).toEqual([
      [input, context],
      [input, context],
    ]);
    expect(delivery.dispatchRealtime).not.toHaveBeenCalled();
  });

  it("propagates deferred failures so the durable outbox can retry them", async () => {
    const failure = new Error("push provider unavailable");
    const delivery = {
      dispatchRealtime: jest.fn().mockResolvedValue(undefined),
      dispatchDeferred: jest.fn().mockRejectedValue(failure),
    };
    const provider = new OutboxBackedMessageFanoutProvider(delivery as never);

    await expect(provider.dispatchDeferred(input, context)).rejects.toBe(failure);
  });
});
