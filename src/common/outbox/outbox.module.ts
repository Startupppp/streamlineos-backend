import { Module } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxConsumerRegistry } from "./outbox-consumer.registry";
import { ExternalEffectLedger } from "./external-effect-ledger";

@Module({
  providers: [OutboxPublisherService, OutboxConsumerRegistry, ExternalEffectLedger],
  exports: [OutboxPublisherService, OutboxConsumerRegistry, ExternalEffectLedger],
})
export class OutboxModule {}
