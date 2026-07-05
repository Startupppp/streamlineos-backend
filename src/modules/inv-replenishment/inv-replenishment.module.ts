import { Module } from "@nestjs/common";
import { InvReplenishmentController } from "./inv-replenishment.controller";
import { InvForecastingController } from "./inv-forecasting.controller";
import { InvReplenishmentService } from "./inv-replenishment.service";
import { InvStockEngineModule } from "../inv-stock-engine/inv-stock-engine.module";

@Module({
  imports: [InvStockEngineModule],
  controllers: [InvReplenishmentController, InvForecastingController],
  providers: [InvReplenishmentService],
  exports: [InvReplenishmentService],
})
export class InvReplenishmentModule {}
