import { Module } from "@nestjs/common";
import { OnboardingModule } from "./core/onboarding.module";
import { OnboardingFlowModule } from "./flow/onboarding-flow.module";

const ONBOARDING_MODULES = [OnboardingModule, OnboardingFlowModule];

@Module({
  imports: ONBOARDING_MODULES,
  exports: ONBOARDING_MODULES,
})
export class OnboardingRootModule {}
