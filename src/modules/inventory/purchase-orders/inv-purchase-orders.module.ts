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
import { InvQuickCommerceModule } from "../channels/quick-commerce/inv-quick-commerce.module";
import { InvHandlingUnitsModule } from "../handling-units/inv-handling-units.module";

@Module({
  // E3/E4. Receiving asks the catalogue module whether a line may be received
  // (`InvPharmacyService`) and whether a quantity may be entered for the SKU
  // (`InvQuantityCaptureService`). Imported rather than re-implemented: a second
  // copy of either rule stays equal to the first until somebody edits one.
  //
  // NEO-2. `InvQuickCommerceModule` for `assertReceivable` — the rule that a
  // delivery may not be received against a purchase order nobody announced. It
  // lives with the ASN rather than here so there is one copy of it.
  imports: [InvQualityModule, InvStockEngineModule, AccountingModule, InvProductsModule, InvQuickCommerceModule, InvHandlingUnitsModule],
  controllers: [InvPurchaseOrdersController, GrnController],
  providers: [PoService, GrnService, GrnPostingService, GrnReadService],
  exports: [PoService, GrnService, GrnPostingService, GrnReadService],
})
export class InvPurchaseOrdersModule {}
