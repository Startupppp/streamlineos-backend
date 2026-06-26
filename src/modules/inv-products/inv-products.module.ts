import { Module } from "@nestjs/common";
import { InvProductsController } from "./inv-products.controller";
import { InvProductsService } from "./inv-products.service";

@Module({
  controllers: [InvProductsController],
  providers: [InvProductsService],
  exports: [InvProductsService],
})
export class InvProductsModule {}
