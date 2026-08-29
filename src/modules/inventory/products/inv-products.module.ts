import { Module } from "@nestjs/common";
import { InvProductsController } from "./inv-products.controller";
import { InvProductsService } from "./inv-products.service";
import { InvProductCrudService } from "./inv-product-crud.service";
import { InvProductCatalogService } from "./inv-product-catalog.service";
import { InvTaxTreatmentService } from "./inv-tax-treatment.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";

@Module({
  imports: [InvStockEngineModule],
  controllers: [InvProductsController],
  providers: [InvProductsService, InvProductCrudService, InvProductCatalogService, InvTaxTreatmentService],
  // E2. `InvTaxTreatmentService` is exported for the document modules: purchase
  // orders, receipts and sales orders each have to snapshot the same inputs, and
  // the composition rule has to be the same rule in all three.
  exports: [InvProductsService, InvTaxTreatmentService],
})
export class InvProductsModule {}
