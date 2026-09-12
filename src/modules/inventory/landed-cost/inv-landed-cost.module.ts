import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { LandedCostController } from "./landed-cost.controller";
import { LandedCostService } from "./landed-cost.service";
import { LandedCostApplyService } from "./landed-cost-apply.service";

/**
 * G5. Both services inject from the stock engine and nowhere else —
 * `NumberSequenceService`, `WarehouseScopeService`, `InventoryAuditService`,
 * `StockEngineService` and `InventoryAccountingBridge`. Nest resolves those at
 * runtime; typecheck cannot see a missing import and the application simply
 * fails to boot, so the import list is the only place this is stated.
 */
@Module({
  imports: [InvStockEngineModule],
  controllers: [LandedCostController],
  providers: [LandedCostService, LandedCostApplyService],
  exports: [LandedCostService, LandedCostApplyService],
})
export class InvLandedCostModule {}
