import { Module } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxFlushController } from "./outbox-flush.controller";

@Module({
  controllers: [OutboxFlushController],
  providers: [OutboxPublisherService],
  exports: [OutboxPublisherService],
})
export class OutboxModule {}
