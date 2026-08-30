import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvStockModule } from "../stock/inv-stock.module";
import { SlottingController, SlottingCronController } from "./slotting.controller";
import { SlottingService } from "./slotting.service";

/**
 * NEO-6. Exported because putaway asks it to re-rank suggestions - the slot rule
 * has one home, and a copy in the warehouses module would stay equal to it only
 * until somebody edited one.
 */
@Module({
  imports: [InvStockEngineModule, InvStockModule],
  controllers: [SlottingController, SlottingCronController],
  providers: [SlottingService],
  exports: [SlottingService],
})
export class InvSlottingModule {}
