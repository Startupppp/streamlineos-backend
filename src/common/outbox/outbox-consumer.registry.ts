import { Injectable } from "@nestjs/common";
import { outboxEvents } from "../../db/schema";

export type OutboxEventRow = typeof outboxEvents.$inferSelect;

export interface OutboxEventConsumer {
  readonly eventType: string;
  handle(event: OutboxEventRow): Promise<void>;
}

@Injectable()
export class OutboxConsumerRegistry {
  private readonly consumers = new Map<string, OutboxEventConsumer>();

  register(consumer: OutboxEventConsumer): void {
    this.consumers.set(consumer.eventType, consumer);
  }

  get(eventType: string): OutboxEventConsumer | undefined {
    return this.consumers.get(eventType);
  }
}
