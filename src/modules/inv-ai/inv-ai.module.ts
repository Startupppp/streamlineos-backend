import { Module } from "@nestjs/common";
import { InvAiController } from "./inv-ai.controller";
import { InvAiService } from "./inv-ai.service";
import { InvAiExplainController } from "./inv-ai-explain.controller";
import { InvAiExplainService } from "./inv-ai-explain.service";
import { AiModule } from "../ai/ai.module";
import { AiConfirmationModule } from "../ai-confirmation/ai-confirmation.module";
import { InvReplenishmentModule } from "../inv-replenishment/inv-replenishment.module";
import { InvVendorsModule } from "../inv-vendors/inv-vendors.module";

@Module({
  imports: [AiModule, AiConfirmationModule, InvReplenishmentModule, InvVendorsModule],
  controllers: [InvAiController, InvAiExplainController],
  providers: [InvAiService, InvAiExplainService],
  exports: [InvAiService, InvAiExplainService],
})
export class InvAiModule {}
