import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvTraceabilityController } from "./inv-traceability.controller";
import { InvTraceabilityService } from "./inv-traceability.service";
import { TraceabilityChainService } from "./traceability-chain.service";

@Module({
  // InvTraceabilityService injects WarehouseScopeService, which only the stock
  // engine module provides. Missing here, tsc is happy and the app cannot boot.
  imports: [InvStockEngineModule],
  controllers: [InvTraceabilityController],
  providers: [InvTraceabilityService, TraceabilityChainService],
  exports: [InvTraceabilityService, TraceabilityChainService],
})
export class InvTraceabilityModule {}
