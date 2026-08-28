import { Module } from "@nestjs/common";
import { InvWarehousesController } from "./inv-warehouses.controller";
import { InvWarehousesService } from "./inv-warehouses.service";
import { PutawayService } from "./putaway.service";
import { WarehouseAssignmentsService } from "./warehouse-assignments.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";

@Module({
  // InvWarehousesService injects WarehouseScopeService, which InvStockEngineModule owns
  // and exports. Without this import Nest cannot construct the service and the whole
  // application fails to boot — typecheck cannot see it, because DI is resolved at runtime.
  imports: [InvStockEngineModule],
  controllers: [InvWarehousesController],
  providers: [InvWarehousesService, PutawayService, WarehouseAssignmentsService],
  exports: [InvWarehousesService, PutawayService, WarehouseAssignmentsService],
})
export class InvWarehousesModule {}
