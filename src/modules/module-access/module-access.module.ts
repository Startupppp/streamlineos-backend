import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ModuleAccessController } from "./module-access.controller";
import { ModuleAccessService } from "./module-access.service";
import { ModuleAccessGroupsService } from "./module-access-groups.service";
import { UserPermissionGrantsController } from "./user-permission-grants.controller";
import { UserPermissionGrantsService } from "./user-permission-grants.service";

@Module({
  imports: [AccessModule],
  controllers: [ModuleAccessController, UserPermissionGrantsController],
  providers: [
    ModuleAccessService,
    ModuleAccessGroupsService,
    UserPermissionGrantsService,
  ],
})
export class ModuleAccessModule {}
