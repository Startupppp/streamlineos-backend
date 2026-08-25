import { Module } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxFlushController } from "./outbox-flush.controller";
import { OutboxConsumerRegistry } from "./outbox-consumer.registry";

@Module({
  controllers: [OutboxFlushController],
  providers: [OutboxPublisherService, OutboxConsumerRegistry],
  exports: [OutboxPublisherService, OutboxConsumerRegistry],
})
export class OutboxModule {}
