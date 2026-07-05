import { Module } from "@nestjs/common";
import { StockEngineService } from "./stock-engine.service";
import { ReservationService } from "./reservation.service";
import { NumberSequenceService } from "./number-sequence.service";
import { InventorySettingsService } from "./inventory-settings.service";
import { InventoryAuditService } from "./inventory-audit.service";

@Module({
  providers: [
    StockEngineService,
    ReservationService,
    NumberSequenceService,
    InventorySettingsService,
    InventoryAuditService,
  ],
  exports: [
    StockEngineService,
    ReservationService,
    NumberSequenceService,
    InventorySettingsService,
    InventoryAuditService,
  ],
})
export class InvStockEngineModule {}
