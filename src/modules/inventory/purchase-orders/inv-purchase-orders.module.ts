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
import { InvProductsModule } from "../products/inv-products.module";

@Module({
  // E3/E4. Receiving asks the catalogue module whether a line may be received
  // (`InvPharmacyService`) and whether a quantity may be entered for the SKU
  // (`InvQuantityCaptureService`). Imported rather than re-implemented: a second
  // copy of either rule stays equal to the first until somebody edits one.
  imports: [InvQualityModule, InvStockEngineModule, AccountingModule, InvProductsModule],
  controllers: [InvPurchaseOrdersController, GrnController],
  providers: [PoService, GrnService, GrnPostingService, GrnReadService],
  exports: [PoService, GrnService, GrnPostingService, GrnReadService],
})
export class InvPurchaseOrdersModule {}
