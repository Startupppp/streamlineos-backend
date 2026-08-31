import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvSettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [InvSettingsController],
  providers: [SettingsService],
})
export class InvSettingsModule {}
