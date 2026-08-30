import { Module } from "@nestjs/common";
import { PickWaveController } from "./pick-wave.controller";
import { PickExceptionController } from "./pick-exception.controller";
import { PickWaveService } from "./pick-wave.service";
import { PickConfirmService } from "./pick-confirm.service";
import { PickExceptionReportService } from "./pick-exception-report.service";
import { PickCompletionService } from "./pick-completion.service";
import { PickExceptionService } from "./pick-exception.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvBarcodeModule } from "../barcode/inv-barcode.module";
import { InvSalesOrdersModule } from "../sales-orders/inv-sales-orders.module";
import { InvLaborModule } from "../labor/inv-labor.module";

@Module({
  // PickWaveService injects WarehouseScopeService, NumberSequenceService,
  // InventorySettingsService and InventoryAuditService from the stock engine, and
  // SoCoreService from sales orders for the shared FEFO/FIFO allocator;
  // PickConfirmService adds InvBarcodeService, and -- R3 -- InventorySettingsService
  // plus SoCoreService, so a confirm with no location can re-run the same shared
  // allocator rather than writing a quantity to nowhere;
  // PickExceptionReportService adds
  // ReservationService, InventorySettingsService and SoCoreService -- B5 needs
  // those three to release a short pick's reservation and to re-promise a
  // substituted line through the shared allocator; PickCompletionService adds
  // ReservationService and StockProjectionService; PickExceptionService adds
  // WarehouseScopeService. Nest resolves all of these at runtime; typecheck
  // cannot see a missing import, and the application simply fails to boot.
  imports: [InvStockEngineModule, InvBarcodeModule, InvSalesOrdersModule, InvLaborModule],
  controllers: [PickWaveController, PickExceptionController],
  providers: [
    PickWaveService,
    PickConfirmService,
    PickCompletionService,
    PickExceptionReportService,
    PickExceptionService,
  ],
  exports: [
    PickWaveService,
    PickConfirmService,
    PickExceptionReportService,
    PickExceptionService,
  ],
})
export class InvPickingModule {}
