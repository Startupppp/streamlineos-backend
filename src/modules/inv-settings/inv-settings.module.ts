import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../inv-stock-engine/inv-stock-engine.module";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class InvSettingsModule {}
