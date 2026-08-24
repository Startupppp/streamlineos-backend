import { Module } from "@nestjs/common";
import { AiGatewayModule } from "../ai/core/gateway/ai-gateway.module";
import { DealsModule } from "../deals/deals.module";
import { AutonomyService } from "./autonomy.service";

/**
 * The part of the product that acts without being asked.
 *
 * It owns no model client of its own — every call goes through
 * `AiGatewayModule`, which is what makes credits reserved before the provider
 * call and refunded on its failure rather than something this module has to
 * remember.
 */
@Module({
  imports: [AiGatewayModule, DealsModule],
  providers: [AutonomyService],
  exports: [AutonomyService],
})
export class AutonomyModule {}
