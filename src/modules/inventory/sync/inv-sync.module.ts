import { Module } from "@nestjs/common";
import { SyncBatchController } from "./sync-batch.controller";
import { SyncBatchService } from "./sync-batch.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvPickingModule } from "../picking/inv-picking.module";
import { InvPurchaseOrdersModule } from "../purchase-orders/inv-purchase-orders.module";
import { InvBarcodeModule } from "../barcode/inv-barcode.module";

@Module({
  // Every service that owns one of the queued operation kinds online is
  // injected here; Nest resolves these at runtime and typecheck cannot see a
  // missing import. B8 added receiving and the barcode capture, so a device
  // queue holding a receive count or a scan has somewhere to replay it.
  imports: [
    InvStockEngineModule,
    InvPickingModule,
    InvPurchaseOrdersModule,
    InvBarcodeModule,
  ],
  controllers: [SyncBatchController],
  providers: [SyncBatchService],
  exports: [SyncBatchService],
})
export class InvSyncModule {}
