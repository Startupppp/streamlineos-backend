import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../../accounting/kernel/accounting-kernel.module";
import { AccountingAdaptersModule } from "../../accounting/adapters/accounting-adapters.module";
import { StockEngineService } from "./stock-engine.service";
import { StockEngineBatchService } from "./stock-engine-batch.service";
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
import { MovementApplyService } from "./movement-apply.service";
import { ChannelPoolService } from "./channel-pool.service";

@Module({
  // The kernel for the period guard (BooksService, PeriodsService); the adapters
  // for PostingCommandService, which InventoryAccountingBridge posts through.
  imports: [AccountingKernelModule, AccountingAdaptersModule],
  providers: [
    StockProjectionService,
    StockEngineService,
    StockEngineBatchService,
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
    MovementApplyService,
    ChannelPoolService,
  ],
  exports: [StockProjectionService, 
    StockEngineService,
    StockEngineBatchService,
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
    MovementApplyService,
    ChannelPoolService,
  ],
})
export class InvStockEngineModule {}
