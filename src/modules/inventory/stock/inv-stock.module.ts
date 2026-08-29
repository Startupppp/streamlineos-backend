import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvStockController } from "./inv-stock.controller";
import { InvStockAdjustmentsController } from "./inv-stock-adjustments.controller";
import { InvStockTransfersController } from "./inv-stock-transfers.controller";
import { TransitExitController } from "./transit-exit.controller";
import { InvStockService } from "./inv-stock.service";
import { InvStockReservationsService } from "./inv-stock-reservations.service";
import { InvStockAdjustmentsService } from "./inv-stock-adjustments.service";
import { InvStockTransfersService } from "./inv-stock-transfers.service";
import { TransitExitService } from "./transit-exit.service";

// R3. TransitExitService takes StockEngineService, InventoryAuditService,
// WarehouseScopeService and TransitLocationService, all from InvStockEngineModule.
// Nest resolves those at runtime; typecheck cannot see a missing import and the
// application simply fails to boot.
@Module({
  imports: [InvStockEngineModule],
  controllers: [
    InvStockController,
    InvStockAdjustmentsController,
    InvStockTransfersController,
    TransitExitController,
  ],
  providers: [
    InvStockService,
    InvStockReservationsService,
    InvStockAdjustmentsService,
    InvStockTransfersService,
    TransitExitService,
  ],
  exports: [
    InvStockService,
    InvStockAdjustmentsService,
    InvStockTransfersService,
    TransitExitService,
  ],
})
export class InvStockModule {}
