import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../../stock-engine/inv-stock-engine.module";
import { ChannelPoolsController } from "./channel-pools.controller";

/**
 * NEO-1. The service itself lives in `stock-engine/` — availability is engine
 * territory and the reservation path has to consult it — so this module is the
 * HTTP surface and nothing else.
 */
@Module({
  imports: [InvStockEngineModule],
  controllers: [ChannelPoolsController],
})
export class InvChannelPoolsModule {}
