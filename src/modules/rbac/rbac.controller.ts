import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { RbacService } from "./rbac.service";
import {
  assignRolePermissionSchema,
  revokeRolePermissionSchema,
  type AssignRolePermissionInput,
  type RevokeRolePermissionInput,
} from "./dto/rbac.schemas";

@Controller("rbac")
@UseGuards(JwtAuthGuard)
export class RbacController {
  constructor(
    private readonly rbac: RbacService,
    private readonly access: AccessService,
  ) {}

  @Get("permissions")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  getPermissions() {
    return this.rbac.getAllPermissions();
  }

  @Post("role-permissions")
  @HttpCode(200)
  @Idempotent("rbac.rolePermission.assign")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ body: assignRolePermissionSchema })
  assignRolePermission(
    @Body() body: AssignRolePermissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rbac.assignRolePermission(u, body);
  }

  @Delete("role-permissions")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  @Validate({ body: revokeRolePermissionSchema })
  revokeRolePermission(
    @Body() body: RevokeRolePermissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rbac.revokeRolePermission(u, body);
  }

  @Get("access-snapshot")
  @Universal()
  getAccessSnapshot(@CurrentUser() u: CurrentUserContext) {
    return this.access.getAccessSnapshot(u.orgId, u.userId, u);
  }

  @Get("discovery/permissions")
  @AuthorizedInService(
    "RbacService.getDiscoveryPermissions narrows the catalog to the caller's allowedModules",
  )
  getDiscoveryPermissions(@CurrentUser() u: CurrentUserContext) {
    return this.rbac.getDiscoveryPermissions(u);
  }

  @Get("discovery/grantable")
  @AuthorizedInService(
    "RbacService.getDiscoveryGrantable narrows to what the caller themselves may delegate",
  )
  getDiscoveryGrantable(@CurrentUser() u: CurrentUserContext) {
    return this.rbac.getDiscoveryGrantable(u);
  }

  @Get("discovery/templates")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  getDiscoveryTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.rbac.getDiscoveryTemplates(u);
  }

  @Get("discovery/members")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  getDiscoveryMembers(@CurrentUser() u: CurrentUserContext) {
    return this.rbac.getDiscoveryMembers(u.orgId);
  }
}
