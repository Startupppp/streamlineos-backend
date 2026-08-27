import { Module } from "@nestjs/common";
import { InvReconciliationController } from "./inv-reconciliation.controller";
import { InvReconciliationService } from "./inv-reconciliation.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";

@Module({
  // WarehouseScopeService and InventoryAuditService both come from the stock
  // engine module; without the import the application does not boot.
  imports: [InvStockEngineModule],
  controllers: [InvReconciliationController],
  providers: [InvReconciliationService],
  exports: [InvReconciliationService],
})
export class InvReconciliationModule {}
