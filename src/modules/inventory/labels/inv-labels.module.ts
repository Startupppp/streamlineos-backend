import { Module } from "@nestjs/common";
import { InvBarcodeModule } from "../barcode/inv-barcode.module";
import { InvPurchaseOrdersModule } from "../purchase-orders/inv-purchase-orders.module";
import { InvPickingModule } from "../picking/inv-picking.module";
import { InvLabelsController } from "./inv-labels.controller";
import { InvLabelsService } from "./inv-labels.service";

/**
 * G4. Imports the three modules whose data these documents render —
 * `InvBarcodeService` for a label, `GrnReadService` + `PoService` for a receipt,
 * `PickWaveService` for a wave — and provides nothing of its own but the
 * rendering.
 *
 * The direction is one-way and must stay so: picking already imports the barcode
 * module, so nothing in picking, receiving or barcode may ever import this one.
 * `pnpm check:cycles` is what holds that.
 */
@Module({
  imports: [InvBarcodeModule, InvPurchaseOrdersModule, InvPickingModule],
  controllers: [InvLabelsController],
  providers: [InvLabelsService],
  exports: [InvLabelsService],
})
export class InvLabelsModule {}
