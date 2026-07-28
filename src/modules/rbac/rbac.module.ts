import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RbacController } from "./rbac.controller";
import { RolesController } from "./roles.controller";
import { RbacService } from "./rbac.service";
import { RolesService } from "./roles.service";
import { RoleLockoutService } from "./role-lockout.service";
import { RolePermissionService } from "./role-permission.service";
import { RoleMemberService } from "./role-member.service";

@Module({
  imports: [AccessModule, NotificationsModule],
  controllers: [RbacController, RolesController],
  providers: [
    RbacService,
    RolesService,
    RoleLockoutService,
    RolePermissionService,
    RoleMemberService,
  ],
})
export class RbacModule {}
