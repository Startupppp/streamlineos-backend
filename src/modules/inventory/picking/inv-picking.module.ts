import { Module } from "@nestjs/common";
import { PickWaveController } from "./pick-wave.controller";
import { PickWaveService } from "./pick-wave.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvBarcodeModule } from "../barcode/inv-barcode.module";

@Module({
  // PickWaveService injects WarehouseScopeService and NumberSequenceService from
  // the stock engine, and InvBarcodeService to verify a scan against the line.
  // Nest resolves these at runtime; typecheck cannot see a missing import, and
  // the application simply fails to boot.
  imports: [InvStockEngineModule, InvBarcodeModule],
  controllers: [PickWaveController],
  providers: [PickWaveService],
  exports: [PickWaveService],
})
export class InvPickingModule {}
