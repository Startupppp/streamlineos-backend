import { Module } from "@nestjs/common";
import { InvWarehousesController } from "./inv-warehouses.controller";
import { InvWarehousesService } from "./inv-warehouses.service";

@Module({
  controllers: [InvWarehousesController],
  providers: [InvWarehousesService],
  exports: [InvWarehousesService],
})
export class InvWarehousesModule {}
