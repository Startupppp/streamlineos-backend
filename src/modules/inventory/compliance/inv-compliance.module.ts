import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { IndiaComplianceService } from "./india-compliance.service";

/**
 * E5 — the Indian statutory boundary.
 *
 * Exports the service and nothing else: a caller registers a document and reads
 * what came back. There is deliberately no controller yet — nothing in the
 * product asks a user to file an invoice, and a route that could be called
 * before a document is complete is a way to file a draft.
 */
@Module({
  imports: [InvStockEngineModule, OutboxModule],
  providers: [IndiaComplianceService],
  exports: [IndiaComplianceService],
})
export class InvComplianceModule {}
