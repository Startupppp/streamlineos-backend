import { Module } from "@nestjs/common";
import { InvPurchaseOrdersController } from "./inv-purchase-orders.controller";
import { GrnController } from "./grn.controller";
import { PoService } from "./po.service";
import { GrnService } from "./grn.service";
import { GrnPostingService } from "./grn-post.service";
import { GrnReceiveService } from "./grn-receive.service";
import { GrnReadService } from "./grn-read.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { AccountingModule } from "../../accounting/core/accounting.module";
import { InvQualityModule } from "../quality/inv-quality.module";
import { InvProductsModule } from "../products/inv-products.module";
import { InvQuickCommerceModule } from "../channels/quick-commerce/inv-quick-commerce.module";
import { InvHandlingUnitsModule } from "../handling-units/inv-handling-units.module";

@Module({
  imports: [InvQualityModule, InvStockEngineModule, AccountingModule, InvProductsModule, InvQuickCommerceModule, InvHandlingUnitsModule],
  controllers: [InvPurchaseOrdersController, GrnController],
  providers: [PoService, GrnService, GrnPostingService, GrnReceiveService, GrnReadService],
  exports: [PoService, GrnService, GrnPostingService, GrnReceiveService, GrnReadService],
})
export class InvPurchaseOrdersModule {}
