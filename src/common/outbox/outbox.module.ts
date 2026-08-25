import { Module } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxConsumerRegistry } from "./outbox-consumer.registry";

@Module({
  providers: [OutboxPublisherService, OutboxConsumerRegistry],
  exports: [OutboxPublisherService, OutboxConsumerRegistry],
})
export class OutboxModule {}
