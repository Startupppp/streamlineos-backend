import { Module } from "@nestjs/common";
import { InvGlReconController } from "./inv-gl-recon.controller";
import { InvGlReconService } from "./inv-gl-recon.service";
import { InvStockEngineModule } from "../../stock-engine/inv-stock-engine.module";
import { InvValuationModule } from "../../valuation/inv-valuation.module";

@Module({
  // WarehouseScopeService and InventoryAccountingBridge come from the stock engine;
  // InventoryPeriodService from valuation, which owns the period grain (D5).
  imports: [InvStockEngineModule, InvValuationModule],
  controllers: [InvGlReconController],
  providers: [InvGlReconService],
  exports: [InvGlReconService],
})
export class InvGlReconModule {}
