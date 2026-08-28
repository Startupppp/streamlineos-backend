import { Module } from "@nestjs/common";
import { InvReplenishmentController } from "./inv-replenishment.controller";
import { InvForecastingController } from "./inv-forecasting.controller";
import { InvReplenishmentService } from "./inv-replenishment.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { InvStockLowConsumerService } from "./inv-stock-low-consumer.service";
import { DemandBaselineService } from "./forecast/demand-baseline.service";
import { SafetyStockPolicyService } from "./forecast/safety-stock-policy.service";

@Module({
  imports: [InvStockEngineModule, OutboxModule, NotificationsModule],
  controllers: [InvReplenishmentController, InvForecastingController],
  providers: [InvReplenishmentService, InvStockLowConsumerService, DemandBaselineService, SafetyStockPolicyService],
  exports: [DemandBaselineService, InvReplenishmentService],
})
export class InvReplenishmentModule {}
