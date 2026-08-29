import { Module } from "@nestjs/common";
import { InvProductsController } from "./inv-products.controller";
import { InvProductsService } from "./inv-products.service";
import { InvProductCrudService } from "./inv-product-crud.service";
import { InvProductCatalogService } from "./inv-product-catalog.service";
import { InvTaxTreatmentService } from "./inv-tax-treatment.service";
import { InvPharmacyService } from "./inv-pharmacy.service";
import { InvQuantityCaptureService } from "./inv-quantity-capture.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";

@Module({
  imports: [InvStockEngineModule],
  controllers: [InvProductsController],
  providers: [
    InvProductsService, InvProductCrudService, InvProductCatalogService, InvTaxTreatmentService,
    InvPharmacyService, InvQuantityCaptureService,
  ],
  // E2. `InvTaxTreatmentService` is exported for the document modules: purchase
  // orders, receipts and sales orders each have to snapshot the same inputs, and
  // the composition rule has to be the same rule in all three.
  //
  // E3/E4. `InvPharmacyService` and `InvQuantityCaptureService` are exported for
  // the same reason and to the same callers. Receiving calls
  // `assertReceiptLine` before it posts and `assertEnteredQuantity` before it
  // converts; picking calls `dispensingProfile` at the shelf. A second copy of
  // either rule in a document module is a copy that stays equal until somebody
  // edits one of them.
  exports: [InvProductsService, InvTaxTreatmentService, InvPharmacyService, InvQuantityCaptureService],
})
export class InvProductsModule {}
