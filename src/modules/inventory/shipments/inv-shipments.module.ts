import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { CarriersController } from "./carriers.controller";
import { PackagesController } from "./packages.controller";
import { ShipmentsController } from "./shipments.controller";
import { LoadsController } from "./loads.controller";
import { CarriersService } from "./carriers.service";
import { PackagesService } from "./packages.service";
import { ShipmentsService } from "./shipments.service";
import { LoadsService } from "./loads.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [CarriersController, PackagesController, ShipmentsController, LoadsController],
  providers: [CarriersService, PackagesService, ShipmentsService, LoadsService],
  exports: [CarriersService, PackagesService, ShipmentsService, LoadsService],
})
export class InvShipmentsModule {}
