import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { HrAutomationsModule } from "../hr-automations/hr-automations.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { OnboardingFlowModule } from "../onboarding-flow/onboarding-flow.module";

@Module({
  imports: [AutomationModule, HrAutomationsModule, OnboardingFlowModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
