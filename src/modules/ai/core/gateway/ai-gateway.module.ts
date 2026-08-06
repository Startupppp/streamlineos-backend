import { Module } from "@nestjs/common";
import { BillingModule } from "../../../billing/core/billing.module";
import { AiCreditsService } from "../../../billing/core/ai-credits.service";
import { LlmService } from "../providers/llm.service";
import { AiUsageService } from "../services/ai-usage.service";
import { AiGatewayService } from "./ai-gateway.service";
import { AI_CREDIT_LEDGER } from "./credit-ledger.interface";

@Module({
  imports: [BillingModule],
  providers: [
    LlmService,
    AiUsageService,
    AiGatewayService,
    { provide: AI_CREDIT_LEDGER, useExisting: AiCreditsService },
  ],
  exports: [LlmService, AiUsageService, AiGatewayService, AI_CREDIT_LEDGER],
})
export class AiGatewayModule {}
