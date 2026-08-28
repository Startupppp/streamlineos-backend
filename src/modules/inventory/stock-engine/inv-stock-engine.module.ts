import { Module } from "@nestjs/common";
import { AccountingGlModule } from "../../accounting/gl/accounting-gl.module";
import { AccountingPostingModule } from "../../accounting/posting/accounting-posting.module";
import { StockEngineService } from "./stock-engine.service";
import { ReservationService } from "./reservation.service";
import { NumberSequenceService } from "./number-sequence.service";
import { InventorySettingsService } from "./inventory-settings.service";
import { InventoryAuditService } from "./inventory-audit.service";
import { ValuationService } from "./valuation.service";
import { WarehouseScopeService } from "./warehouse-scope.service";
import { CostVisibilityService } from "./cost-visibility";
import { MovementCostingService } from "./movement-costing.service";
import { InventoryAccountingBridge } from "./accounting-bridge";
import { UomConversionService } from "./uom-conversion.service";
import { StockProjectionService } from "./stock-projection.service";
import { TransitLocationService } from "./transit-location.service";

@Module({
  imports: [AccountingGlModule, AccountingPostingModule],
  providers: [StockProjectionService, 
    StockEngineService,
    ReservationService,
    NumberSequenceService,
    InventorySettingsService,
    InventoryAuditService,
    ValuationService,
    WarehouseScopeService,
    CostVisibilityService,
    MovementCostingService,
    InventoryAccountingBridge,
    UomConversionService,
    TransitLocationService,
  ],
  exports: [StockProjectionService, 
    StockEngineService,
    ReservationService,
    NumberSequenceService,
    InventorySettingsService,
    InventoryAuditService,
    ValuationService,
    WarehouseScopeService,
    CostVisibilityService,
    MovementCostingService,
    InventoryAccountingBridge,
    UomConversionService,
    TransitLocationService,
  ],
})
export class InvStockEngineModule {}
