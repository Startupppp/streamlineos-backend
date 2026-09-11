import { Module } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxConsumerRegistry } from "./outbox-consumer.registry";
import { ExternalEffectLedger } from "./external-effect-ledger";
import { OutboxReportService } from "./outbox-report.service";
import { OutboxReplayService } from "./outbox-replay.service";

@Module({
  providers: [
    OutboxReportService,
    OutboxPublisherService,
    OutboxReplayService,
    OutboxConsumerRegistry,
    ExternalEffectLedger,
  ],
  exports: [OutboxPublisherService, OutboxReplayService, OutboxConsumerRegistry, ExternalEffectLedger],
})
export class OutboxModule {}
