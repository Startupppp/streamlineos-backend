import { Module } from "@nestjs/common";
import { InvProductsController } from "./inv-products.controller";
import { InvProductCrudService } from "./inv-product-crud.service";
import { InvProductCatalogService } from "./inv-product-catalog.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";

@Module({
  imports: [InvStockEngineModule],
  controllers: [InvProductsController],
  providers: [InvProductCrudService, InvProductCatalogService],
  exports: [],
})
export class InvProductsModule {}
