import { Module } from "@nestjs/common";
import { InvReconciliationController } from "./inv-reconciliation.controller";
import { InvReconciliationService } from "./inv-reconciliation.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvGlReconModule } from "./gl/inv-gl-recon.module";

@Module({
  // WarehouseScopeService and InventoryAuditService both come from the stock
  // engine module; without the import the application does not boot.
  // D6: the inventory-to-GL reconciliation is a sub-module of this one, so it
  // reaches the router through the registration this module already has.
  imports: [InvStockEngineModule, InvGlReconModule],
  controllers: [InvReconciliationController],
  providers: [InvReconciliationService],
  exports: [InvReconciliationService, InvGlReconModule],
})
export class InvReconciliationModule {}
