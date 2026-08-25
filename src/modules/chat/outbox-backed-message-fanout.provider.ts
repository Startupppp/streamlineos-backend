import { Injectable } from "@nestjs/common";
import {
  type FanoutDeliveryContext,
  type FanoutInput,
  type MessageFanoutProvider,
} from "./message-fanout.interface";
import { ChatMessageFanoutService } from "./chat-message-fanout.service";

/**
 * The provider used by the chat outbox consumer.
 *
 * The transactional producer is ChatMessagesService: it writes the complete
 * `chat.message.fanout` payload before its transaction commits. This adapter
 * therefore does not enqueue, publish, or retry anything itself. Its deferred
 * method is called only after the outbox worker has claimed a durable row, and
 * a thrown error is intentionally returned to that worker for retry/dead-letter
 * handling. Realtime is a separate method because it is published once by the
 * post-commit send hook; the outbox consumer must never call it.
 *
 * Keeping this as a concrete adapter makes the queued choice visible at the
 * Nest seam and leaves the delivery implementation swappable without moving
 * transaction or retry policy into the chat send path.
 */
@Injectable()
export class OutboxBackedMessageFanoutProvider implements MessageFanoutProvider {
  constructor(private readonly delivery: ChatMessageFanoutService) {}

  dispatchRealtime(input: FanoutInput, context?: FanoutDeliveryContext): Promise<void> {
    return this.delivery.dispatchRealtime(input, context);
  }

  dispatchDeferred(input: FanoutInput, context?: FanoutDeliveryContext): Promise<void> {
    return this.delivery.dispatchDeferred(input, context);
  }
}
