import { Module } from "@nestjs/common";
import { AiGatewayModule } from "../ai/core/gateway/ai-gateway.module";
import { DealsModule } from "../deals/deals.module";
import { AccessModule } from "../access/access.module";
import { AutonomyService } from "./autonomy.service";
import { AutonomyActionsService } from "./autonomy-actions.service";
import { AutonomyReviewService } from "./autonomy-review.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";
import { AutonomyHoldService } from "./autonomy-hold.service";
import { AutonomyHoldWorkflow } from "./autonomy-hold.workflow";
import { AutonomyReversalService } from "./autonomy-reversal.service";
import { QuotesModule } from "../quotes/quotes.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { WorkflowModule } from "../../common/workflow/workflow.module";
import { DataQualityModule } from "../data-quality/data-quality.module";
import { AutonomyReviewController } from "./autonomy-review.controller";

/**
 * The part of the product that acts without being asked.
 *
 * It owns no model client of its own — every call goes through
 * `AiGatewayModule`, which is what makes credits reserved before the provider
 * call and refunded on its failure rather than something this module has to
 * remember.
 *
 * It also owns the review surface, because the feed is a reading of the same
 * decision ledger this module writes -- putting it elsewhere would mean two
 * modules agreeing on what a decision means.
 *
 * `DataQualityModule` is imported for one number. The scoreboard is where a
 * tenant asks whether any of this is working, and how good the dataset is
 * belongs in that answer rather than on a second surface nobody would think to
 * open -- a rising correction rate and a rising dataset-health penalty are
 * usually the same story. The dependency runs this way round because the queue
 * knows nothing about autonomy and should not start to.
 */
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
    AutonomyReversalService,
    AutonomyReviewService,
    AutonomyScoringService,
    AutonomyHoldService,
    AutonomyHoldWorkflow,
  ],
  exports: [AutonomyService, AutonomyReviewService, AutonomyScoringService, AutonomyHoldService],
})
export class AutonomyModule {}
