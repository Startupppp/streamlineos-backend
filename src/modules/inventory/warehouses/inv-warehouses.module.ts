import { Module } from "@nestjs/common";
import { InvWarehousesController } from "./inv-warehouses.controller";
import { InvWarehousesService } from "./inv-warehouses.service";
import { PutawayService } from "./putaway.service";
import { WarehouseAssignmentsService } from "./warehouse-assignments.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvSlottingModule } from "../slotting/inv-slotting.module";

@Module({
  // InvWarehousesService injects WarehouseScopeService, which InvStockEngineModule owns
  // and exports. Without this import Nest cannot construct the service and the whole
  // application fails to boot — typecheck cannot see it, because DI is resolved at runtime.
  //
  // NEO-6. `InvSlottingModule` for `SlottingService.slotFor` — putaway asks the
  // slotting module where a SKU belongs rather than carrying a second copy of
  // the rule. No cycle: slotting imports the engine and the stock module, and
  // neither imports warehouses.
  imports: [InvStockEngineModule, InvSlottingModule],
  controllers: [InvWarehousesController],
  providers: [InvWarehousesService, PutawayService, WarehouseAssignmentsService],
  exports: [InvWarehousesService, PutawayService, WarehouseAssignmentsService],
})
export class InvWarehousesModule {}
