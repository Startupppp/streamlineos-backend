import { Module } from "@nestjs/common";
import { OrgController } from "./org.controller";
import { OrgMembersService } from "./org-members.service";
import { OrgSetupService } from "./org-setup.service";
import { AnnouncementsController } from "./announcements.controller";
import { AnnouncementsService } from "./announcements.service";

@Module({
  controllers: [OrgController, AnnouncementsController],
  providers: [OrgMembersService, OrgSetupService, AnnouncementsService],
})
export class OrgModule {}
