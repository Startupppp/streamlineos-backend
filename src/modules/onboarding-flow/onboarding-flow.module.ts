import { Module } from "@nestjs/common";
import { OnboardingSessionService } from "./onboarding-session.service";
import { ModuleChecklistService } from "./module-checklist.service";
import { GuidedTourService } from "./guided-tour.service";
import { OnboardingAnalyticsService } from "./onboarding-analytics.service";
import { HrChecklistReconciliationService } from "./hr-checklist-reconciliation.service";

// Business-logic services shared by OrgModule (/org/setup/session) and OnboardingModule
// (/onboarding/module-checklists, /onboarding/tours).
// HTTP routes live on those modules' existing controllers rather than a new controller
// here, because /onboarding/:userId is a catch-all route registered in OnboardingController
// — a second controller sharing the /onboarding prefix risks that catch-all shadowing new
// static routes depending on cross-module registration order. See onboarding.controller.ts.
@Module({
  providers: [
    OnboardingSessionService,
    ModuleChecklistService,
    GuidedTourService,
    OnboardingAnalyticsService,
    HrChecklistReconciliationService,
  ],
  exports: [
    OnboardingSessionService,
    ModuleChecklistService,
    GuidedTourService,
    OnboardingAnalyticsService,
    HrChecklistReconciliationService,
  ],
})
export class OnboardingFlowModule {}
