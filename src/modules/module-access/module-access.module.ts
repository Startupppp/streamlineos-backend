import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ModuleAccessController } from "./module-access.controller";
import { ModuleAccessService } from "./module-access.service";
import { ModuleAccessGroupsService } from "./module-access-groups.service";
import { ModuleAccessRosterService } from "./module-access-roster.service";
import { ModuleAccessFlatMembersService } from "./module-access-flat-members.service";
import { ModuleAccessOwnershipService } from "./module-access-ownership.service";
import { UserPermissionGrantsController } from "./user-permission-grants.controller";
import { UserPermissionGrantsService } from "./user-permission-grants.service";
import { ModuleStandingRosterService } from "./module-standing-roster.service";
import { ModuleStandingMutationsService } from "./module-standing-mutations.service";
import { ModuleAccessGroupPolicyService } from "./module-access-group-policy.service";
import { ModuleAccessGroupCrudService } from "./module-access-group-crud.service";
import { ModuleAccessGroupMembersService } from "./module-access-group-members.service";

@Module({
  imports: [AccessModule],
  controllers: [ModuleAccessController, UserPermissionGrantsController],
  providers: [
    ModuleAccessService,
    ModuleAccessGroupsService,
    ModuleAccessRosterService,
    ModuleAccessFlatMembersService,
    ModuleAccessOwnershipService,
    ModuleAccessGroupPolicyService,
    ModuleAccessGroupCrudService,
    ModuleAccessGroupMembersService,
    UserPermissionGrantsService,
    ModuleStandingRosterService,
    ModuleStandingMutationsService,
  ],
})
export class ModuleAccessModule {}
