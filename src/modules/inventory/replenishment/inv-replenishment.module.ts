import { Module } from "@nestjs/common";
import { InvReplenishmentController } from "./inv-replenishment.controller";
import { InvForecastingController } from "./inv-forecasting.controller";
import { InvTransferRecommendationsController } from "./inv-transfer-recommendations.controller";
import { InvPoBatchesController } from "./inv-po-batches.controller";
import { InvForecastDriftController } from "./inv-forecast-drift.controller";
import { InvReplenishmentService } from "./inv-replenishment.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvStockModule } from "../stock/inv-stock.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { InvStockLowConsumerService } from "./inv-stock-low-consumer.service";
import { DemandBaselineService } from "./forecast/demand-baseline.service";
import { SafetyStockPolicyService } from "./forecast/safety-stock-policy.service";
import { LeadTimeService } from "./forecast/lead-time.service";
import { ReorderProposalService } from "./forecast/reorder-proposal.service";
import { ReplenishmentSimulatorService } from "./forecast/replenishment-simulator.service";
import { TransferRecommendationService } from "./forecast/transfer-recommendation.service";
import { TransferApprovalService } from "./forecast/transfer-approval.service";
import { PoBatchService } from "./forecast/po-batch.service";
import { ForecastDriftService } from "./forecast/forecast-drift.service";
import { DriftMonitorService } from "./forecast/drift-monitor.service";
import { ForecastPersistenceService } from "./forecast/forecast-persistence.service";

@Module({
  imports: [InvStockEngineModule, InvStockModule, OutboxModule, NotificationsModule],
  controllers: [
    InvReplenishmentController,
    InvForecastingController,
    InvTransferRecommendationsController,
    InvPoBatchesController,
    InvForecastDriftController,
  ],
  providers: [InvReplenishmentService, InvStockLowConsumerService, DemandBaselineService, SafetyStockPolicyService, LeadTimeService, ReorderProposalService, ReplenishmentSimulatorService, TransferRecommendationService, TransferApprovalService, PoBatchService, ForecastDriftService, DriftMonitorService, ForecastPersistenceService],
  exports: [DemandBaselineService, InvReplenishmentService, LeadTimeService, ForecastPersistenceService],
})
export class InvReplenishmentModule {}
