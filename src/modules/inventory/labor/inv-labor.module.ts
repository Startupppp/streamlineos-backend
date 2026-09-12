import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { LaborController } from "./labor.controller";
import { LaborService } from "./labor.service";

/**
 * NEO-7. Exported because picking and putaway write their own labour records
 * from inside the command that finished the work - a record cannot exist for a
 * confirmation that rolled back, and a confirmation cannot happen without one.
 */
@Module({
  imports: [InvStockEngineModule],
  controllers: [LaborController],
  providers: [LaborService],
  exports: [LaborService],
})
export class InvLaborModule {}
