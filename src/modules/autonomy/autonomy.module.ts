import { Module } from "@nestjs/common";
import { AiGatewayModule } from "../ai/core/gateway/ai-gateway.module";
import { DealsModule } from "../deals/deals.module";
import { AccessModule } from "../access/access.module";
import { AutonomyService } from "./autonomy.service";
import { AutonomyReviewService } from "./autonomy-review.service";
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
  imports: [AiGatewayModule, DealsModule, AccessModule],
  controllers: [AutonomyReviewController],
  providers: [AutonomyService, AutonomyReviewService],
  exports: [AutonomyService, AutonomyReviewService],
})
export class AutonomyModule {}
