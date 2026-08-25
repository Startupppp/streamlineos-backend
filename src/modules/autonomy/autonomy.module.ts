import { Module } from "@nestjs/common";
import { AiGatewayModule } from "../ai/core/gateway/ai-gateway.module";
import { DealsModule } from "../deals/deals.module";
import { AccessModule } from "../access/access.module";
import { AutonomyService } from "./autonomy.service";
import { AutonomyReviewService } from "./autonomy-review.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";
import { AutonomyHoldService } from "./autonomy-hold.service";
import { AutonomyHoldWorkflow } from "./autonomy-hold.workflow";
import { QuotesModule } from "../quotes/quotes.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { WorkflowModule } from "../../common/workflow/workflow.module";
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
 */
@Module({
  imports: [AiGatewayModule, DealsModule, AccessModule, QuotesModule, NotificationsModule, WorkflowModule],
  controllers: [AutonomyReviewController],
  providers: [
    AutonomyService,
    AutonomyReviewService,
    AutonomyScoringService,
    AutonomyHoldService,
    AutonomyHoldWorkflow,
  ],
  exports: [AutonomyService, AutonomyReviewService, AutonomyScoringService, AutonomyHoldService],
})
export class AutonomyModule {}
