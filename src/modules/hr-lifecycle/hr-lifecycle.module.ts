import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
import { HrTemplatesModule } from "../hr-templates/hr-templates.module";
import { ExitController } from "./exit.controller";
import { TerminationController } from "./termination.controller";
import { AlumniController } from "./alumni.controller";
import { HrAnalyticsController } from "./hr-analytics.controller";
import { HrDashboardController } from "./hr-dashboard.controller";
import { OnboardingViewsController } from "./onboarding-views.controller";
import { ExitService } from "./exit.service";
import { ExitWriteService } from "./exit-write.service";
import { TerminationService } from "./termination.service";
import { AlumniService } from "./alumni.service";
import { HrAnalyticsService } from "./hr-analytics.service";
import { HrDashboardService } from "./hr-dashboard.service";
import { HrDashboardReportsService } from "./hr-dashboard-reports.service";
import { OnboardingViewsService } from "./onboarding-views.service";
import { ResignationJobsService } from "./resignation-jobs.service";

@Module({
  imports: [AutomationModule, NotificationsModule, HrAutomationsModule, HrTemplatesModule],
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
    ExitWriteService,
    TerminationService,
    AlumniService,
    HrAnalyticsService,
    HrDashboardService,
    HrDashboardReportsService,
    OnboardingViewsService,
    ResignationJobsService,
  ],
})
export class HrLifecycleModule {}
