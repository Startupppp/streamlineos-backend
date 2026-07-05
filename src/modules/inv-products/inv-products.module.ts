import { Module } from "@nestjs/common";
import { InvProductsController } from "./inv-products.controller";
import { InvProductsService } from "./inv-products.service";
import { InvStockEngineModule } from "../inv-stock-engine/inv-stock-engine.module";

@Module({
  imports: [InvStockEngineModule],
  controllers: [InvProductsController],
  providers: [InvProductsService],
  exports: [InvProductsService],
})
export class InvProductsModule {}
