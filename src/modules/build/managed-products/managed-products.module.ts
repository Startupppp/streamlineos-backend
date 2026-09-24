import { Module } from "@nestjs/common";
import { ManagedProductsController } from "./managed-products.controller";
import { ManagedProductsService } from "./managed-products.service";

@Module({
  controllers: [ManagedProductsController],
  providers: [ManagedProductsService],
})
export class BuildManagedProductsModule {}
