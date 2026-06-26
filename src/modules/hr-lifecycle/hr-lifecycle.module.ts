import { Module } from "@nestjs/common";
import { ExitController } from "./exit.controller";
import { TerminationController } from "./termination.controller";
import { AlumniController } from "./alumni.controller";
import { HrAnalyticsController } from "./hr-analytics.controller";
import { HrDashboardController } from "./hr-dashboard.controller";
import { OnboardingViewsController } from "./onboarding-views.controller";
import { ExitService } from "./exit.service";
import { TerminationService } from "./termination.service";
import { AlumniService } from "./alumni.service";
import { HrAnalyticsService } from "./hr-analytics.service";
import { HrDashboardService } from "./hr-dashboard.service";
import { HrDashboardReportsService } from "./hr-dashboard-reports.service";
import { OnboardingViewsService } from "./onboarding-views.service";

@Module({
  controllers: [
    ExitController,
    TerminationController,
    AlumniController,
    HrAnalyticsController,
    HrDashboardController,
    OnboardingViewsController,
  ],
  providers: [
    ExitService,
    TerminationService,
    AlumniService,
    HrAnalyticsService,
    HrDashboardService,
    HrDashboardReportsService,
    OnboardingViewsService,
  ],
})
export class HrLifecycleModule {}
