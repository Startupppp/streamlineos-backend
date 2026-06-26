import { Module } from "@nestjs/common";
import { OrgController } from "./org.controller";
import { OrgMembersService } from "./org-members.service";

@Module({
  controllers: [OrgController],
  providers: [OrgMembersService],
})
export class OrgModule {}
