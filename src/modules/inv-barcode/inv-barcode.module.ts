import { Module } from "@nestjs/common";
import { InvBarcodeController } from "./inv-barcode.controller";
import { InvBarcodeService } from "./inv-barcode.service";

@Module({
  controllers: [InvBarcodeController],
  providers: [InvBarcodeService],
})
export class InvBarcodeModule {}
