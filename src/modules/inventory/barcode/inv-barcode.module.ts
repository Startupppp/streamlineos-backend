import { Module } from "@nestjs/common";
import { InvBarcodeController } from "./inv-barcode.controller";
import { InvBarcodeService } from "./inv-barcode.service";

@Module({
  controllers: [InvBarcodeController],
  providers: [InvBarcodeService],
  // Exported so picking can verify a scan against the line it is confirming.
  exports: [InvBarcodeService],
})
export class InvBarcodeModule {}
