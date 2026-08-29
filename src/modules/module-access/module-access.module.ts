import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ModuleAccessController } from "./module-access.controller";
import { ModuleAccessService } from "./module-access.service";
import { ModuleAccessGroupsService } from "./module-access-groups.service";
import { UserPermissionGrantsController } from "./user-permission-grants.controller";
import { UserPermissionGrantsService } from "./user-permission-grants.service";
import { ModuleStandingRosterService } from "./module-standing-roster.service";
import { ModuleStandingMutationsService } from "./module-standing-mutations.service";
import { ModuleAccessGroupPolicyService } from "./module-access-group-policy.service";

@Module({
  imports: [AccessModule],
  controllers: [ModuleAccessController, UserPermissionGrantsController],
  providers: [
    ModuleAccessService,
    ModuleAccessGroupsService,
    ModuleAccessGroupPolicyService,
    UserPermissionGrantsService,
    ModuleStandingRosterService,
    ModuleStandingMutationsService,
  ],
})
export class ModuleAccessModule {}
