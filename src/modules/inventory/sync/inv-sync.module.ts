import { Module } from "@nestjs/common";
import { SyncBatchController } from "./sync-batch.controller";
import { SyncBatchService } from "./sync-batch.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvPickingModule } from "../picking/inv-picking.module";

@Module({
  // The engine and the pick-confirm service are both injected; Nest resolves
  // these at runtime and typecheck cannot see a missing import.
  imports: [InvStockEngineModule, InvPickingModule],
  controllers: [SyncBatchController],
  providers: [SyncBatchService],
  exports: [SyncBatchService],
})
export class InvSyncModule {}
