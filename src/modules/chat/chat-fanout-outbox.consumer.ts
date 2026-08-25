import { Injectable, type OnModuleInit } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { InboxConsumer } from "../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../common/outbox/outbox-consumer.registry";
import {
  CHAT_MESSAGE_FANOUT_EVENT,
  chatMessageFanoutPayloadSchema,
  fanoutInputFromPayload,
} from "./chat-fanout-outbox";
import { ChatMessageFanoutService } from "./chat-message-fanout.service";

const CONSUMER_NAME = "chat:message-fanout";

@Injectable()
export class ChatFanoutOutboxConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = CHAT_MESSAGE_FANOUT_EVENT;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly fanout: ChatMessageFanoutService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);
    if (!(await inbox.claim(CONSUMER_NAME, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    }))) return;

    const parsed = chatMessageFanoutPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parsed.error.message);
      return;
    }

    if (parsed.data.orgId !== event.organizationId) {
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        "fan-out payload organization does not match the outbox event",
      );
      return;
    }

    await this.fanout.dispatch(fanoutInputFromPayload(parsed.data));
    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED");
  }
}
