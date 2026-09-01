import { Module } from "@nestjs/common";
import { InvProjectsController } from "./inv-projects.controller";
import { InvProjectsService } from "./inv-projects.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";

/**
 * B1. The engine module owns `ReservationService`, `InventorySettingsService`,
 * `InventoryAuditService` and `WarehouseScopeService`; without this import Nest
 * cannot construct the service and the whole application fails to boot — which
 * typecheck cannot see, because DI resolves at runtime.
 */
@Module({
  imports: [InvStockEngineModule],
  controllers: [InvProjectsController],
  providers: [InvProjectsService],
  exports: [InvProjectsService],
})
export class InvProjectsModule {}
