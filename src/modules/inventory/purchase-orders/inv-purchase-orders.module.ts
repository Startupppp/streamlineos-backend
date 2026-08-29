import { Module } from "@nestjs/common";
import { InvPurchaseOrdersController } from "./inv-purchase-orders.controller";
import { GrnController } from "./grn.controller";
import { PoService } from "./po.service";
import { GrnService } from "./grn.service";
import { GrnPostingService } from "./grn-post.service";
import { GrnReadService } from "./grn-read.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { AccountingModule } from "../../accounting/core/accounting.module";
import { InvQualityModule } from "../quality/inv-quality.module";

@Module({
  imports: [InvQualityModule, InvStockEngineModule, AccountingModule],
  controllers: [InvPurchaseOrdersController, GrnController],
  providers: [PoService, GrnService, GrnPostingService, GrnReadService],
  exports: [PoService, GrnService, GrnPostingService, GrnReadService],
})
export class InvPurchaseOrdersModule {}
