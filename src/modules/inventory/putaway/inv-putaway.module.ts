import { Module } from "@nestjs/common";
import { PutawayTaskController } from "./putaway-task.controller";
import { PutawayTaskService } from "./putaway-task.service";
import { PutawayCompleteService } from "./putaway-complete.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvWarehousesModule } from "../warehouses/inv-warehouses.module";

@Module({
  // PutawayTaskService injects WarehouseScopeService, NumberSequenceService and
  // InventoryAuditService from the stock engine, and PutawayService — the INV-202
  // suggestion engine — from warehouses, which owns it. PutawayCompleteService
  // adds StockEngineService and StockProjectionService. Nest resolves all of
  // these at runtime; typecheck cannot see a missing import, and the application
  // simply fails to boot.
  imports: [InvStockEngineModule, InvWarehousesModule],
  controllers: [PutawayTaskController],
  providers: [PutawayTaskService, PutawayCompleteService],
  exports: [PutawayTaskService, PutawayCompleteService],
})
export class InvPutawayModule {}
