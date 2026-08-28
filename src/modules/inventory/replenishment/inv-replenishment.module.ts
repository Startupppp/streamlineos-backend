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
import { LeadTimeService } from "./forecast/lead-time.service";
import { ReorderProposalService } from "./forecast/reorder-proposal.service";
import { ReplenishmentSimulatorService } from "./forecast/replenishment-simulator.service";
import { TransferRecommendationService } from "./forecast/transfer-recommendation.service";
import { ForecastDriftService } from "./forecast/forecast-drift.service";

@Module({
  imports: [InvStockEngineModule, OutboxModule, NotificationsModule],
  controllers: [InvReplenishmentController, InvForecastingController],
  providers: [InvReplenishmentService, InvStockLowConsumerService, DemandBaselineService, SafetyStockPolicyService, LeadTimeService, ReorderProposalService, ReplenishmentSimulatorService, TransferRecommendationService, ForecastDriftService],
  exports: [DemandBaselineService, InvReplenishmentService, LeadTimeService],
})
export class InvReplenishmentModule {}
