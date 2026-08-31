import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
import { AutomationModule } from "../../../automation/automation.module";
import { NotificationsModule } from "../../../notifications/notifications.module";
import { HrPoliciesModule } from "../../policies/hr-policies.module";
import { OnboardingProbationService } from "./onboarding-probation.service";
import { HrAutomationsModule } from "../../automations/hr-automations.module";
import { OnboardingFlowModule } from "../flow/onboarding-flow.module";
import { OnboardingRequirementsService } from "./onboarding-requirements.service";
import { HrCoreModule } from "../../core/hr-core.module";
import { HrLifecycleModule } from "../../lifecycle/hr-lifecycle.module";
import { OnboardingTemplateService } from "./onboarding-template.service";
import { OnboardingDetailsService } from "./onboarding-details.service";
import { OnboardingTaskService } from "./onboarding-task.service";
import { OnboardingAdminService } from "./onboarding-admin.service";
import { OnboardingInitiationService } from "./onboarding-initiation.service";
import { OnboardingInitiationDispatchService } from "./onboarding-initiation-dispatch.service";
import { OnboardingSubmissionService } from "./onboarding-submission.service";

@Module({
  imports: [
    AutomationModule,
    HrPoliciesModule,
    HrAutomationsModule,
    OnboardingFlowModule,
    HrCoreModule,
    HrLifecycleModule,
    NotificationsModule,
  ],
  providers: [
    OnboardingProbationService,
    OnboardingRequirementsService,
    OnboardingTemplateService,
    OnboardingDetailsService,
    OnboardingTaskService,
    OnboardingAdminService,
    OnboardingInitiationService,
    OnboardingInitiationDispatchService,
    OnboardingSubmissionService,
  ],
  controllers: [OnboardingController],
})
export class OnboardingModule {}
