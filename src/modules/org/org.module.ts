import { Module } from "@nestjs/common";
import { OrgController } from "./org.controller";
import { OrgMembersService } from "./org-members.service";
import { OrgSetupService } from "./org-setup.service";

@Module({
  controllers: [OrgController],
  providers: [OrgMembersService, OrgSetupService],
})
export class OrgModule {}
