import { Module } from "@nestjs/common";
import { AiGatewayModule } from "../ai/core/gateway/ai-gateway.module";
import { CallAnalysisController } from "./call-analysis.controller";
import { CallAnalysisVisibilityService } from "./call-analysis-visibility.service";
import { CallAnalysisService } from "./call-analysis.service";
import { CallCoachingController } from "./call-coaching.controller";
import { CallCoachingService } from "./call-coaching.service";

/**
 * Per-call analysis.
 *
 * `AiGatewayModule` is imported rather than the provider being constructed
 * here, which is the platform rule and also the reason credits, redaction and
 * usage attribution apply to this feature without it doing anything: the
 * gateway is the only path to a model in this codebase, and a module that
 * reached a provider SDK directly would silently opt out of all three.
 *
 * The services are exported because the analysis is a fact about a call that
 * other CRM surfaces will want — a deal's health, a rep's coaching view — and
 * the cache means those reads cost nothing. Any such surface must go through
 * `CallAnalysisVisibilityService` as well, which is why that is exported beside
 * it: a reader that takes `CallAnalysisService` alone and renders what it gets
 * has silently opted out of the rule that a rep sees their own analysis first.
 *
 * `AccessService` is not imported here and is not missing — `AccessModule` is
 * `@Global()`, so `CallAnalysisVisibilityService` resolves it without an import
 * edge. Adding one would be a cycle waiting to happen.
 */
@Module({
  imports: [AiGatewayModule],
  controllers: [CallAnalysisController, CallCoachingController],
  providers: [CallAnalysisService, CallAnalysisVisibilityService, CallCoachingService],
  exports: [CallAnalysisService, CallAnalysisVisibilityService],
})
export class CallsModule {}
