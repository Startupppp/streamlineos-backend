import { Module } from "@nestjs/common";
import { AiGatewayModule } from "../ai/core/gateway/ai-gateway.module";
import { CallAnalysisController } from "./call-analysis.controller";
import { CallAnalysisVisibilityService } from "./call-analysis-visibility.service";
import { CallAnalysisService } from "./call-analysis.service";
import { CallCoachingController } from "./call-coaching.controller";
import { CallCoachingService } from "./call-coaching.service";
import { CallRecordingConsentController } from "./call-recording-consent.controller";
import { CallRecordingConsentService } from "./call-recording-consent.service";

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
 * `CallRecordingConsentService` is a constructor dependency of both
 * `CallAnalysisService` and `CallCoachingService` rather than a thing a route
 * remembers to call, which is phase 5 ticket 03's enforcement. In a two-party
 * consent jurisdiction, analysing a recording nobody agreed to is a criminal
 * matter, so there must be no way to obtain an analysis out of this module
 * without passing the rule — and there is no provider anywhere that can turn it
 * off. It is exported for the same reason the visibility service is: the next
 * surface that wants call data has to be able to ask, and asking is cheaper than
 * a second copy of the rule.
 *
 * `AccessService` is not imported here and is not missing — `AccessModule` is
 * `@Global()`, so `CallAnalysisVisibilityService` resolves it without an import
 * edge. Adding one would be a cycle waiting to happen.
 */
@Module({
  imports: [AiGatewayModule],
  controllers: [CallAnalysisController, CallCoachingController, CallRecordingConsentController],
  providers: [
    CallAnalysisService,
    CallAnalysisVisibilityService,
    CallCoachingService,
    CallRecordingConsentService,
  ],
  exports: [CallAnalysisService, CallAnalysisVisibilityService, CallRecordingConsentService],
})
export class CallsModule {}
