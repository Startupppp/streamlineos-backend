import { Module } from "@nestjs/common";
import { WorkspaceOnboardingController } from "./workspace-onboarding.controller";
import { WorkspaceOnboardingService } from "./workspace-onboarding.service";

@Module({
  controllers: [WorkspaceOnboardingController],
  providers: [WorkspaceOnboardingService],
  exports: [WorkspaceOnboardingService],
})
export class WorkspaceOnboardingModule {}
