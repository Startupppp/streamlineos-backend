import { Module } from "@nestjs/common";
import { InvProductsModule } from "../products/inv-products.module";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvBarcodeController } from "./inv-barcode.controller";
import { InvBarcodeService } from "./inv-barcode.service";

@Module({
  // E3. The scan surface shows the pharmacy safety alerts, so it needs the
  // catalogue module that owns them.
  //
  // InvBarcodeService injects WarehouseScopeService, which InvStockEngineModule
  // owns: the on-hand totals a scan reports are narrowed to the buildings the
  // caller holds. Without this import Nest cannot construct the service.
  imports: [InvProductsModule, InvStockEngineModule],
  controllers: [InvBarcodeController],
  providers: [InvBarcodeService],
  // Exported so picking can verify a scan against the line it is confirming.
  exports: [InvBarcodeService],
})
export class InvBarcodeModule {}
