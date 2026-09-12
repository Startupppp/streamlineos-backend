import { Module } from "@nestjs/common";
import { InvProductsController } from "./inv-products.controller";
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
    InvProductCrudService, InvProductCatalogService, InvTaxTreatmentService,
    InvPharmacyService, InvQuantityCaptureService,
  ],
  // E2. `InvTaxTreatmentService` is exported for the document modules: purchase
  // orders, receipts and sales orders each have to snapshot the same inputs, and
  // the composition rule has to be the same rule in all three.
  //
  // E3/E4. `InvPharmacyService` and `InvQuantityCaptureService` are exported for
  // the same reason and to the same callers.
  exports: [InvTaxTreatmentService, InvPharmacyService, InvQuantityCaptureService],
})
export class InvProductsModule {}
