import { Module } from "@nestjs/common";
import { InvPurchaseOrdersController } from "./inv-purchase-orders.controller";
import { GrnController } from "./grn.controller";
import { PoService } from "./po.service";
import { GrnService } from "./grn.service";
import { InvStockEngineModule } from "../inv-stock-engine/inv-stock-engine.module";
import { AccountingModule } from "../accounting/accounting.module";

@Module({
  imports: [InvStockEngineModule, AccountingModule],
  controllers: [InvPurchaseOrdersController, GrnController],
  providers: [PoService, GrnService],
  exports: [PoService, GrnService],
})
export class InvPurchaseOrdersModule {}
