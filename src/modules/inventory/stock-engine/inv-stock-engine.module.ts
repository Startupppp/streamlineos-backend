import { Module } from "@nestjs/common";
import { AccountingGlModule } from "../../accounting/gl/accounting-gl.module";
import { StockEngineService } from "./stock-engine.service";
import { ReservationService } from "./reservation.service";
import { NumberSequenceService } from "./number-sequence.service";
import { InventorySettingsService } from "./inventory-settings.service";
import { InventoryAuditService } from "./inventory-audit.service";
import { ValuationService } from "./valuation.service";
import { WarehouseScopeService } from "./warehouse-scope.service";
import { CostVisibilityService } from "./cost-visibility";
import { MovementCostingService } from "./movement-costing.service";

@Module({
  imports: [AccountingGlModule],
  providers: [
    StockEngineService,
    ReservationService,
    NumberSequenceService,
    InventorySettingsService,
    InventoryAuditService,
    ValuationService,
    WarehouseScopeService,
    CostVisibilityService,
    MovementCostingService,
  ],
  exports: [
    StockEngineService,
    ReservationService,
    NumberSequenceService,
    InventorySettingsService,
    InventoryAuditService,
    ValuationService,
    WarehouseScopeService,
    CostVisibilityService,
    MovementCostingService,
  ],
})
export class InvStockEngineModule {}
