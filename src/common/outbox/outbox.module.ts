import { Module } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxConsumerRegistry } from "./outbox-consumer.registry";
import { ExternalEffectLedger } from "./external-effect-ledger";
import { OutboxReportService } from "./outbox-report.service";

@Module({
  providers: [OutboxReportService, OutboxPublisherService, OutboxConsumerRegistry, ExternalEffectLedger],
  exports: [OutboxPublisherService, OutboxConsumerRegistry, ExternalEffectLedger],
})
export class OutboxModule {}
