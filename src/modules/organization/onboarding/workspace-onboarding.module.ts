import { Module } from "@nestjs/common";
import { WorkspaceOnboardingController } from "./workspace-onboarding.controller";
import { WorkspaceOnboardingService } from "./workspace-onboarding.service";
import { OnboardingFlowModule } from "../../hr/onboarding/flow/onboarding-flow.module";

@Module({
  imports: [OnboardingFlowModule],
  controllers: [WorkspaceOnboardingController],
  providers: [WorkspaceOnboardingService],
  exports: [WorkspaceOnboardingService],
})
export class WorkspaceOnboardingModule {}
