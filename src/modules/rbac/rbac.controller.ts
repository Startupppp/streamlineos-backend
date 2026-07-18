import { Body, Controller, Delete, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { RbacService } from "./rbac.service";
import {
  assignRolePermissionSchema,
  revokeRolePermissionSchema,
  rolePermissionsQuerySchema,
  type AssignRolePermissionInput,
  type RevokeRolePermissionInput,
  type RolePermissionsQuery,
} from "./dto/rbac.schemas";

@Controller("rbac")
@UseGuards(JwtAuthGuard)
export class RbacController {
  constructor(
    private readonly rbac: RbacService,
    private readonly access: AccessService,
  ) {}

  @Get("permissions")
  getPermissions() {
    return this.rbac.getAllPermissions();
  }

  @Get("role-permissions")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  getRolePermissions(
    @Query(new ZodValidationPipe(rolePermissionsQuerySchema)) query: RolePermissionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rbac.getRolePermissions(query.role, u.orgId);
  }

  @Post("role-permissions")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  assignRolePermission(
    @Body(new ZodValidationPipe(assignRolePermissionSchema)) body: AssignRolePermissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rbac.assignRolePermission(u, body);
  }

  @Delete("role-permissions")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:rbac:manage")
  revokeRolePermission(
    @Body(new ZodValidationPipe(revokeRolePermissionSchema)) body: RevokeRolePermissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rbac.revokeRolePermission(u, body);
  }

  @Get("user-permissions")
  getUserPermissions(@CurrentUser() u: CurrentUserContext) {
    return this.rbac.getUserPermissions(u.userId, u.orgId);
  }

  @Get("access-snapshot")
  getAccessSnapshot(@CurrentUser() u: CurrentUserContext) {
    return this.access.getAccessSnapshot(u.orgId, u.userId, u);
  }
}
