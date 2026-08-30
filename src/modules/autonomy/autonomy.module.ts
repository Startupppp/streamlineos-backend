import { Module } from "@nestjs/common";
import { AiGatewayModule } from "../ai/core/gateway/ai-gateway.module";
import { DealsModule } from "../deals/deals.module";
import { AccessModule } from "../access/access.module";
import { AutonomyService } from "./autonomy.service";
import { AutonomyActionsService } from "./autonomy-actions.service";
import { AutonomyReviewService } from "./autonomy-review.service";
import { AutonomyReversalService } from "./autonomy-reversal.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";
import { AutonomyHoldService } from "./autonomy-hold.service";
import { AutonomyHoldWorkflow } from "./autonomy-hold.workflow";
import { QuotesModule } from "../quotes/quotes.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { WorkflowModule } from "../../common/workflow/workflow.module";
import { DataQualityModule } from "../data-quality/data-quality.module";
import { AutonomyReviewController } from "./autonomy-review.controller";

@Module({
  imports: [
    AiGatewayModule,
    DealsModule,
    AccessModule,
    QuotesModule,
    NotificationsModule,
    WorkflowModule,
    DataQualityModule,
  ],
  controllers: [AutonomyReviewController],
  providers: [
    AutonomyService,
    AutonomyActionsService,
    AutonomyReviewService,
    AutonomyReversalService,
    AutonomyScoringService,
    AutonomyHoldService,
    AutonomyHoldWorkflow,
  ],
  exports: [AutonomyService, AutonomyReviewService, AutonomyReversalService, AutonomyScoringService, AutonomyHoldService],
})
export class AutonomyModule {}
