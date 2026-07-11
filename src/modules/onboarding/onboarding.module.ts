import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
import { HrPoliciesModule } from "../hr-policies/hr-policies.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { OnboardingProbationService } from "./onboarding-probation.service";
import { OnboardingFlowModule } from "../onboarding-flow/onboarding-flow.module";

@Module({
  imports: [AutomationModule, HrAutomationsModule, OnboardingFlowModule, HrPoliciesModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, OnboardingProbationService],
})
export class OnboardingModule {}
