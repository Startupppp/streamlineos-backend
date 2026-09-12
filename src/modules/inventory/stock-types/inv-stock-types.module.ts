import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { OwnershipController } from "./stock-types.controller";
import { OwnershipService } from "./ownership.service";

/**
 * NEO-10 / NEO-11 - the two stock *types* that are not a quantity.
 *
 * `catch-weight.ts` is pure and has no service of its own: it is the rules the
 * receiving and selling paths apply at their own boundaries, and giving it a
 * service would put a second gate beside the one that already runs.
 */
@Module({
  imports: [InvStockEngineModule],
  controllers: [OwnershipController],
  providers: [OwnershipService],
  exports: [OwnershipService],
})
export class InvStockTypesModule {}
