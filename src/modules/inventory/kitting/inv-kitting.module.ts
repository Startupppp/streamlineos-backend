import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { KitController } from "./kit.controller";
import { KitService } from "./kit.service";

/** NEO-9. Exported so availability surfaces can ask "how many could we build". */
@Module({
  imports: [InvStockEngineModule],
  controllers: [KitController],
  providers: [KitService],
  exports: [KitService],
})
export class InvKittingModule {}
