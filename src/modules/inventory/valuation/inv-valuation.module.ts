import { Module } from "@nestjs/common";
import { InvValuationController } from "./inv-valuation.controller";
import { InvValuationService } from "./inv-valuation.service";
import { InventoryPeriodService } from "./inventory-period.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";

@Module({
  // Same defect as InvWarehousesModule: InvValuationService injects WarehouseScopeService,
  // which only InvStockEngineModule provides. Missing here, the application cannot boot.
  // InventoryPeriodService injects InventoryAccountingBridge from the same module.
  imports: [InvStockEngineModule],
  controllers: [InvValuationController],
  providers: [InvValuationService, InventoryPeriodService],
  exports: [InvValuationService, InventoryPeriodService],
})
export class InvValuationModule {}
