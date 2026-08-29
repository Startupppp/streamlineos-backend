import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvBarcodeModule } from "../barcode/inv-barcode.module";
import { CarriersController } from "./carriers.controller";
import { PackagesController } from "./packages.controller";
import { ShipmentsController } from "./shipments.controller";
import { LoadsController } from "./loads.controller";
import { CarriersService } from "./carriers.service";
import { PackagesService } from "./packages.service";
import { ShipmentsService } from "./shipments.service";
import { LoadsService } from "./loads.service";
import { CartonizationService } from "./cartonization.service";
import { CartonizationController } from "./cartonization.controller";
import { CarrierStatusService } from "./carrier-status.service";
import { CarrierStatusController } from "./carrier-status.controller";

@Module({
  // B6. Packing resolves a scan the way picking does, so the bench accepts the
  // GTIN, SKU, lot or serial label that happens to be on the box.
  imports: [InvStockEngineModule, InvBarcodeModule],
  controllers: [CarriersController, PackagesController, ShipmentsController, LoadsController, CartonizationController, CarrierStatusController],
  providers: [CarriersService, PackagesService, ShipmentsService, LoadsService, CartonizationService, CarrierStatusService],
  exports: [CarriersService, PackagesService, ShipmentsService, LoadsService, CartonizationService, CarrierStatusService],
})
export class InvShipmentsModule {}
