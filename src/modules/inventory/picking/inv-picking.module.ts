import { Module } from "@nestjs/common";
import { PickWaveController } from "./pick-wave.controller";
import { PickWaveService } from "./pick-wave.service";
import { PickConfirmService } from "./pick-confirm.service";
import { PickCompletionService } from "./pick-completion.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvBarcodeModule } from "../barcode/inv-barcode.module";
import { InvSalesOrdersModule } from "../sales-orders/inv-sales-orders.module";

@Module({
  // PickWaveService injects WarehouseScopeService, NumberSequenceService,
  // InventorySettingsService and InventoryAuditService from the stock engine, and
  // SoCoreService from sales orders for the shared FEFO/FIFO allocator;
  // PickConfirmService adds InvBarcodeService, and PickCompletionService adds
  // ReservationService and StockProjectionService. Nest resolves all of these at
  // runtime; typecheck cannot see a missing import, and the application simply
  // fails to boot.
  imports: [InvStockEngineModule, InvBarcodeModule, InvSalesOrdersModule],
  controllers: [PickWaveController],
  providers: [PickWaveService, PickConfirmService, PickCompletionService],
  exports: [PickWaveService, PickConfirmService],
})
export class InvPickingModule {}
