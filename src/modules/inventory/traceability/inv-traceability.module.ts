import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvTraceabilityController } from "./inv-traceability.controller";
import { InvTraceabilityService } from "./inv-traceability.service";
import { TraceabilityChainService } from "./traceability-chain.service";
import { LotGenealogyService } from "./lot-genealogy.service";
import { AllocationOverrideReportService } from "./allocation-override-report.service";

@Module({
  // InvTraceabilityService injects WarehouseScopeService, which only the stock
  // engine module provides. Missing here, tsc is happy and the app cannot boot.
  imports: [InvStockEngineModule],
  controllers: [InvTraceabilityController],
  providers: [
    InvTraceabilityService,
    TraceabilityChainService,
    LotGenealogyService,
    AllocationOverrideReportService,
  ],
  exports: [
    InvTraceabilityService,
    TraceabilityChainService,
    LotGenealogyService,
    AllocationOverrideReportService,
  ],
})
export class InvTraceabilityModule {}
