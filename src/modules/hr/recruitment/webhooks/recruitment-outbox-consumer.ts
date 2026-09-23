import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../../common/outbox/outbox-consumer.registry";
import { RecruitmentWebhookEmitter } from "./webhook-emitter.service";
import { RECRUITMENT_EVENTS, type RecruitmentEvent } from "../recruitment-webhook-events";

@Injectable()
export class RecruitmentOutboxConsumer implements OnModuleInit {
  private readonly logger = new Logger(RecruitmentOutboxConsumer.name);

  constructor(
    private readonly registry: OutboxConsumerRegistry,
    private readonly emitter: RecruitmentWebhookEmitter,
  ) {}

  onModuleInit(): void {
    for (const eventType of RECRUITMENT_EVENTS) {
      this.registry.register({
        eventType,
        handle: (event: OutboxEventRow) => this.deliver(event),
      });
    }
  }

  private async deliver(event: OutboxEventRow): Promise<void> {
    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};

    await this.emitter.emit(
      event.organizationId,
      event.eventType as RecruitmentEvent,
      {
        ...payload,
        outboxEventType: event.eventType,
      },
      { dedupeKey: event.eventId },
    );
  }
}
