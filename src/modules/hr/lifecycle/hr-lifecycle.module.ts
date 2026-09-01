import { Module } from "@nestjs/common";
import { AutomationModule } from "../../automation/automation.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { HrAutomationsModule } from "../automations/hr-automations.module";
import { HrTemplatesModule } from "../templates/hr-templates.module";
import { HrPoliciesModule } from "../policies/hr-policies.module";
import { HrWorkflowsModule } from "../workflows/hr-workflows.module";
import { HrCoreModule } from "../core/hr-core.module";
import { HrDirectoryModule } from "../directory/hr-directory.module";
import { HrEnterpriseOpsModule } from "../enterprise-ops/hr-enterprise-ops.module";
import { OrganizationModule } from "../../organization/core/organization.module";
import { ExitController } from "./exit.controller";
import { TerminationController } from "./termination.controller";
import { AlumniController } from "./alumni.controller";
import { HrAnalyticsController } from "./hr-analytics.controller";
import { HrDashboardController } from "./hr-dashboard.controller";
import { OnboardingViewsController } from "./onboarding-views.controller";
import { HrOnboardingDocsAdminController } from "./hr-onboarding-docs-admin.controller";
import { ProbationController } from "./probation.controller";
import { ExitService } from "./exit.service";
import { ExitWriteService } from "./exit-write.service";
import { ExperienceLetterService } from "./experience-letter.service";
import { ExitCompletionGuardService } from "./exit-completion-guard.service";
import { TerminationService } from "./termination.service";
import { TerminationReadService } from "./termination-read.service";
import { TerminationLifecycleService } from "./termination-lifecycle.service";
import { TerminationCommunicationsService } from "./termination-communications.service";
import { AlumniService } from "./alumni.service";
import { HrAnalyticsService } from "./hr-analytics.service";
import { HrDashboardService } from "./hr-dashboard.service";
import { HrDashboardReportsService } from "./hr-dashboard-reports.service";
import { OnboardingViewsService } from "./onboarding-views.service";
import { ResignationJobsService } from "./resignation-jobs.service";
import { ProbationService } from "./probation.service";
import { ProbationReviewReaderService } from "./probation-review-reader.service";
import { ExitChecklistService } from "./exit-checklist.service";
import { EmploymentFactsModule } from "../../directory/employment-facts.module";

@Module({
  imports: [
    EmploymentFactsModule,
    AutomationModule, NotificationsModule, HrAutomationsModule, HrTemplatesModule, HrPoliciesModule, HrWorkflowsModule, HrCoreModule, HrDirectoryModule, HrEnterpriseOpsModule, OrganizationModule],
  controllers: [
    ExitController,
    TerminationController,
    AlumniController,
    HrAnalyticsController,
    HrDashboardController,
    OnboardingViewsController,
    HrOnboardingDocsAdminController,
    ProbationController,
  ],
  providers: [
    ExitService,
    ExitWriteService,
    ExperienceLetterService,
    ExitCompletionGuardService,
    TerminationReadService,
    TerminationLifecycleService,
    TerminationService,
    TerminationCommunicationsService,
    AlumniService,
    HrAnalyticsService,
    HrDashboardService,
    HrDashboardReportsService,
    OnboardingViewsService,
    ResignationJobsService,
    ProbationService,
    ProbationReviewReaderService,
    ExitChecklistService,
  ],
  exports: [ExitService, HrDashboardService, ProbationService],
})
export class HrLifecycleModule {}
