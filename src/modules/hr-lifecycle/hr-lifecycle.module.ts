import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
import { HrTemplatesModule } from "../hr-templates/hr-templates.module";
import { HrPoliciesModule } from "../hr-policies/hr-policies.module";
import { HrWorkflowsModule } from "../hr-workflows/hr-workflows.module";
import { HrCoreModule } from "../hr-core/hr-core.module";
import { HrDirectoryModule } from "../hr-directory/hr-directory.module";
import { ExitController } from "./exit.controller";
import { TerminationController } from "./termination.controller";
import { AlumniController } from "./alumni.controller";
import { HrAnalyticsController } from "./hr-analytics.controller";
import { HrDashboardController } from "./hr-dashboard.controller";
import { OnboardingViewsController } from "./onboarding-views.controller";
import { ProbationController } from "./probation.controller";
import { ExitService } from "./exit.service";
import { ExitWriteService } from "./exit-write.service";
import { TerminationService } from "./termination.service";
import { AlumniService } from "./alumni.service";
import { HrAnalyticsService } from "./hr-analytics.service";
import { HrDashboardService } from "./hr-dashboard.service";
import { HrDashboardReportsService } from "./hr-dashboard-reports.service";
import { OnboardingViewsService } from "./onboarding-views.service";
import { ResignationJobsService } from "./resignation-jobs.service";
import { ProbationService } from "./probation.service";
import { ExitChecklistService } from "./exit-checklist.service";

@Module({
  imports: [AutomationModule, NotificationsModule, HrAutomationsModule, HrTemplatesModule, HrPoliciesModule, HrWorkflowsModule, HrCoreModule, HrDirectoryModule],
  controllers: [
    ExitController,
    TerminationController,
    AlumniController,
    HrAnalyticsController,
    HrDashboardController,
    OnboardingViewsController,
    ProbationController,
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
    ProbationService,
    ExitChecklistService,
  ],
  exports: [ProbationService],
})
export class HrLifecycleModule {}
