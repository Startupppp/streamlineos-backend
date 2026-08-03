import { Module } from "@nestjs/common";
import { OrgController } from "./org.controller";
import { OrgMembersService } from "./org-members.service";
import { OrgSetupService } from "./org-setup.service";
import { AnnouncementsController } from "./announcements.controller";
import { AnnouncementsService } from "./announcements.service";
import { OnboardingFlowModule } from "../../hr/onboarding/flow/onboarding-flow.module";

@Module({
  imports: [OnboardingFlowModule],
  controllers: [OrgController, AnnouncementsController],
  providers: [OrgMembersService, OrgSetupService, AnnouncementsService],
})
export class OrgModule {}
