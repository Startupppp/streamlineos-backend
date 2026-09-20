import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RbacController } from "./rbac.controller";
import { RolesController } from "./roles.controller";
import { PrincipalGroupsController } from "./principal-groups.controller";
import { RbacService } from "./rbac.service";
import { RolesService } from "./roles.service";
import { RoleSeedService } from "./role-seed.service";
import { RolesQueryService } from "./roles-query.service";
import { RolePermissionService } from "./role-permission.service";
import { RoleMemberService } from "./role-member.service";
import { PrincipalGroupsService } from "./principal-groups.service";
import { PermissionCatalogSyncService } from "./permission-catalog-sync.service";
import { RoleGrantReconcilerService } from "./role-grant-reconciler.service";
import { CronLeaseService } from "../cron/cron-lease.service";

@Module({
  imports: [AccessModule, NotificationsModule],
  controllers: [RbacController, RolesController, PrincipalGroupsController],
  providers: [
    RbacService,
    RolesService,
    RoleSeedService,
    RolesQueryService,
    RoleMemberService,
    RolePermissionService,
    PrincipalGroupsService,
    PermissionCatalogSyncService,
    RoleGrantReconcilerService,
    CronLeaseService,
  ],
})
export class RbacModule {}
