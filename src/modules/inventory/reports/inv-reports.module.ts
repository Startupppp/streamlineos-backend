import { Module } from "@nestjs/common";
import { InvReportsController } from "./inv-reports.controller";
import { InvReportsService } from "./inv-reports.service";
import { InvReportsExtendedService } from "./inv-reports-extended.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvValuationModule } from "../valuation/inv-valuation.module";
import { OperationsMetricsService } from "./operations-metrics.service";

@Module({
  // InvReportsService and InvReportsExtendedService inject WarehouseScopeService, which
  // InvStockEngineModule owns. Without this the application cannot boot — DI is resolved
  // at runtime, so typecheck stays green.
  // D5: the valuation route delegates to InvValuationService rather than keeping a second
  // copy of the same costing dispatch, so that module is imported for its provider.
  imports: [InvStockEngineModule, InvValuationModule],
  controllers: [InvReportsController],
  providers: [InvReportsService, InvReportsExtendedService, OperationsMetricsService],
  exports: [InvReportsService, InvReportsExtendedService],
})
export class InvReportsModule {}
