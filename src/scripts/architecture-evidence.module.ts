import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module";
import { DrizzleModule } from "../db/drizzle.module";
import { OutboxPublisherService } from "../common/outbox/outbox-publisher.service";
import { OutboxConsumerRegistry } from "../common/outbox/outbox-consumer.registry";
import { OutboxReportService } from "../common/outbox/outbox-report.service";
import { ExternalEffectLedger } from "../common/outbox/external-effect-ledger";

/**
 * Minimal application context for architecture evidence commands.
 *
 * These commands inspect tenant data and do not serve HTTP or need the full
 * product graph. Booting AppModule made evidence depend on unrelated external
 * integrations and could hang before producing a report.
 */
@Module({
  imports: [ConfigModule, DrizzleModule],
  providers: [
    OutboxConsumerRegistry,
    OutboxReportService,
    OutboxPublisherService,
    ExternalEffectLedger,
  ],
  exports: [OutboxPublisherService, ExternalEffectLedger],
})
export class ArchitectureEvidenceModule {}
