import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { ChannelsController } from "./channels.controller";
import { TplController } from "./tpl.controller";
import { ChannelsService } from "./channels.service";
import { TplService } from "./tpl.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [ChannelsController, TplController],
  providers: [ChannelsService, TplService],
})
export class InvChannelsModule {}
