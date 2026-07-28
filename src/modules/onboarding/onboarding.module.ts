import { Module } from "@nestjs/common";
import { OnboardingService } from "./onboarding.service";
import { OnboardingController } from "./onboarding.controller";
import { AutomationModule } from "../automation/automation.module";
import { HrPoliciesModule } from "../hr-policies/hr-policies.module";
import { OnboardingProbationService } from "./onboarding-probation.service";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
import { OnboardingFlowModule } from "../onboarding-flow/onboarding-flow.module";
import { OnboardingRequirementsService } from "./onboarding-requirements.service";
import { HrCoreModule } from "../hr-core/hr-core.module";
import { HrLifecycleModule } from "../hr-lifecycle/hr-lifecycle.module";
import { OnboardingTemplateService } from "./onboarding-template.service";
import { OnboardingDetailsService } from "./onboarding-details.service";
import { OnboardingTaskService } from "./onboarding-task.service";
import { OnboardingAdminService } from "./onboarding-admin.service";

@Module({
  imports: [
    AutomationModule,
    HrPoliciesModule,
    HrAutomationsModule,
    OnboardingFlowModule,
    HrCoreModule,
    HrLifecycleModule,
  ],
  providers: [
    OnboardingService,
    OnboardingProbationService,
    OnboardingRequirementsService,
    OnboardingTemplateService,
    OnboardingDetailsService,
    OnboardingTaskService,
    OnboardingAdminService,
  ],
  controllers: [OnboardingController],
})
export class OnboardingModule {}
