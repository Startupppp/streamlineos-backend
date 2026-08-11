import { Module } from "@nestjs/common";
import { StockEngineService } from "./stock-engine.service";
import { ReservationService } from "./reservation.service";
import { NumberSequenceService } from "./number-sequence.service";
import { InventorySettingsService } from "./inventory-settings.service";
import { InventoryAuditService } from "./inventory-audit.service";
import { ValuationService } from "./valuation.service";
import { WarehouseScopeService } from "./warehouse-scope.service";

@Module({
  providers: [
    StockEngineService,
    ReservationService,
    NumberSequenceService,
    InventorySettingsService,
    InventoryAuditService,
    ValuationService,
    WarehouseScopeService,
  ],
  exports: [
    StockEngineService,
    ReservationService,
    NumberSequenceService,
    InventorySettingsService,
    InventoryAuditService,
    ValuationService,
    WarehouseScopeService,
  ],
})
export class InvStockEngineModule {}
