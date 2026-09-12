import { Module } from "@nestjs/common";
import { InvMetricsController } from "./inv-metrics.controller";
import { InventoryMetricsService } from "./inventory-metrics.service";

/**
 * G6 — inventory observability.
 *
 * The counters themselves are a module-level singleton rather than a provider
 * (see `inventory-counters.ts`), so this module exists for the query side and
 * the endpoint that serves it.
 */
@Module({
  controllers: [InvMetricsController],
  providers: [InventoryMetricsService],
  exports: [InventoryMetricsService],
})
export class InvObservabilityModule {}
