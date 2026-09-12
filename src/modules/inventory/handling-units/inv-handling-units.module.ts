import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { HandlingUnitsController } from "./handling-units.controller";
import { HandlingUnitService } from "./handling-unit.service";

/**
 * NEO-4. Exported because receiving asks `assertCanHoldStockInTx` before it
 * posts into a unit - the leaf-only rule has one home, and a copy in the GRN
 * path would stay equal to it only until somebody edited one.
 */
@Module({
  imports: [InvStockEngineModule],
  controllers: [HandlingUnitsController],
  providers: [HandlingUnitService],
  exports: [HandlingUnitService],
})
export class InvHandlingUnitsModule {}
