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
import { CarrierAdapterRegistry } from "./carrier-adapter";

@Module({
  // B6. Packing resolves a scan the way picking does, so the bench accepts the
  // GTIN, SKU, lot or serial label that happens to be on the box.
  imports: [InvStockEngineModule, InvBarcodeModule],
  controllers: [CarriersController, PackagesController, ShipmentsController, LoadsController, CartonizationController, CarrierStatusController],
  // B7. The adapter registry is a provider rather than a module-level singleton
  // so a test can register a fake carrier against the real service graph — which
  // is the only way a boundary with no real implementation gets exercised at all.
  providers: [CarriersService, PackagesService, ShipmentsService, LoadsService, CartonizationService, CarrierStatusService, CarrierAdapterRegistry],
  exports: [CarriersService, PackagesService, ShipmentsService, LoadsService, CartonizationService, CarrierStatusService, CarrierAdapterRegistry],
})
export class InvShipmentsModule {}
