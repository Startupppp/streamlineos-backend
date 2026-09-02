import { Module } from "@nestjs/common";
import { AiCreditsModule } from "../../../billing/core/ai-credits.module";
import { AiCreditsService } from "../../../billing/core/ai-credits.service";
import { LlmService } from "../providers/llm.service";
import { AiUsageService } from "../services/ai-usage.service";
import { AiGatewayService } from "./ai-gateway.service";
import { AiResponseCacheService } from "./ai-response-cache.service";
import { AiConcurrencyLimiter } from "./ai-concurrency-limiter";
import { AI_CREDIT_LEDGER } from "./credit-ledger.interface";

@Module({
  imports: [AiCreditsModule],
  providers: [
    LlmService,
    AiUsageService,
    AiResponseCacheService,
    AiConcurrencyLimiter,
    AiGatewayService,
    { provide: AI_CREDIT_LEDGER, useExisting: AiCreditsService },
  ],
  exports: [LlmService, AiUsageService, AiGatewayService, AiResponseCacheService, AI_CREDIT_LEDGER],
})
export class AiGatewayModule {}
