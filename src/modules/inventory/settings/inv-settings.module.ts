import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";
import { ShelfLifeRulesService } from "./shelf-life-rules.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [SettingsController],
  providers: [SettingsService, ShelfLifeRulesService],
})
export class InvSettingsModule {}
